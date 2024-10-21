const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const AWS = require("aws-sdk");
const dotenv = require("dotenv");

// Load the .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 80;

const minInstances = 0;
const maxInstances = 20;
const activeRequests = new Map();

const amiId = "ami-088a14e0e35670155"; // Replace with your actual AMI ID
const instanceType = "t2.micro"; // Replace with the desired instance type
const keyName = "project2"; // Replace with the name of your EC2 key pair

// Configure AWS
AWS.config.update({ region: "us-east-1" });
const sqs = new AWS.SQS({ apiVersion: "2012-11-05" });
const ec2 = new AWS.EC2({ apiVersion: "2016-11-15" });

// Full SQS Queue URLs
const ASU_ID = "1229850390";
const requestQueueUrl = `https://sqs.us-east-1.amazonaws.com/442042549532/${ASU_ID}-req-queue`;
const responseQueueUrl = `https://sqs.us-east-1.amazonaws.com/442042549532/${ASU_ID}-resp-queue`;

// Set up multer to handle file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});

// Limit file size and validate file type (only accept .jpg files)
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".jpg" && ext !== ".jpeg") {
      return cb(new Error("Only .jpg or .jpeg files are allowed"));
    }
    cb(null, true);
  },
});

// Create uploads directory if not exists
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.post("/", upload.single("inputFile"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  try {
    const filenameWithoutExt = path.basename(
      req.file.originalname,
      path.extname(req.file.originalname)
    );

    // Store the response in activeRequests using the imageKey as the key
    activeRequests.set(req.file.originalname, res);

    // Send a message to the request queue (including image content)
    const messageParams = {
      QueueUrl: requestQueueUrl,
      MessageBody: JSON.stringify({
        imageKey: req.file.originalname,
        imageContent: fs.readFileSync(req.file.path).toString("base64"), // Send image as base64 string
      }),
    };
    await sqs.sendMessage(messageParams).promise();
    console.log(`Message sent to SQS: ${req.file.originalname}`);

    // Do not send a response immediately
  } catch (err) {
    console.log("Error:", err);
    res.status(500).send("Error processing the request");
  } finally {
    fs.unlinkSync(req.file.path); // Clean up the uploaded file
  }
});

async function pollForResponses() {
  const receiveParams = {
    QueueUrl: responseQueueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 20,
  };

  while (true) {
    try {
      const responseData = await sqs.receiveMessage(receiveParams).promise();
      if (responseData.Messages && responseData.Messages.length > 0) {
        for (const messageData of responseData.Messages) {
          const message = JSON.parse(messageData.Body);
          const imageKey = message.fileName;
          const classificationResult = message.classificationResult;

          // Check if this imageKey corresponds to an active request
          if (activeRequests.has(imageKey)) {
            const res = activeRequests.get(imageKey);
            activeRequests.delete(imageKey); // Remove the request from the map

            // Send the response back to the client
            res.send(`${imageKey}:${classificationResult}`);

            // Delete the message from SQS after processing
            const deleteParams = {
              QueueUrl: responseQueueUrl,
              ReceiptHandle: messageData.ReceiptHandle,
            };
            await sqs.deleteMessage(deleteParams).promise();
          }
        }
      }
    } catch (err) {
      console.error("Error polling for responses:", err);
    }

    // await delay(1000); // Delay between polls to avoid overloading SQS
  }
}

async function getQueueLength() {
  const params = {
    QueueUrl: requestQueueUrl,
    AttributeNames: ["ApproximateNumberOfMessages"],
  };
  const data = await sqs.getQueueAttributes(params).promise();
  return parseInt(data.Attributes.ApproximateNumberOfMessages, 10);
}

// Get the number of running app-tier instances
async function getRunningInstances() {
  const data = await ec2
    .describeInstances({
      Filters: [{ Name: "tag:Name", Values: ["app-tier-instance-*"] }],
    })
    .promise();

  let runningInstances = [];
  for (const reservation of data.Reservations) {
    for (const instance of reservation.Instances) {
      if (instance.State.Name === "running") {
        runningInstances.push(instance.InstanceId);
      }
    }
  }
  return runningInstances;
}

let instanceCounter = 1;
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Launch a new app-tier instance
async function launchInstances(numInstancesToLaunch) {
  const userDataScript = `#!/bin/bash
    sudo docker run -d -e AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} -e AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} -e AWS_REGION=${process.env.AWS_REGION} tanmaysalunke/apptier:latest`;

  const instancesToLaunch = [];

  // Generate instance launch params for each instance
  for (let i = 0; i < numInstancesToLaunch; i++) {
    const params = {
      ImageId: amiId,
      InstanceType: instanceType,
      MinCount: 1, // Launch one instance at a time
      MaxCount: 1, // Launch up to this many instances
      KeyName: keyName,
      SecurityGroupIds: ["sg-0273f2abaf816cfe1"],
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "Name", Value: `app-tier-instance-${instanceCounter}` },
          ],
        },
      ],
      UserData: Buffer.from(userDataScript).toString("base64"), // Base64 encode the user-data script
    };

    instancesToLaunch.push(ec2.runInstances(params).promise());
    console.log(
      `Launching instance with name: app-tier-instance-${instanceCounter}`
    );
    instanceCounter++; // Increment the counter for the next instance

    // Add a delay to avoid hitting the API request limit
    await delay(1000); // Wait for 1 second between launching instances
  }

  // wait for all instances to launch
  const data = await Promise.all(instancesToLaunch);
  data.forEach((instanceData) => {
    console.log(
      `Launched instance(s):`,
      instanceData.Instances.map((i) => i.InstanceId)
    );
  });
}

// Terminate an app-tier instance
async function terminateInstance(instanceId) {
  const params = {
    InstanceIds: [instanceId],
  };
  await ec2.terminateInstances(params).promise();
  console.log(`Terminated instance: ${instanceId}`);
}

// Autoscaling logic
async function autoscaleAppTier() {
  const queueLength = await getQueueLength();
  const runningInstances = await getRunningInstances();
  const numRunningInstances = runningInstances.length;

  console.log(`Queue length: ${queueLength}`);
  console.log(`Running instances: ${numRunningInstances}`);

  // Calculate how many instances we need to launch based on queue length
  const numInstancesToLaunch = Math.min(
    queueLength - numRunningInstances,
    maxInstances - numRunningInstances
  );

  // Scale out (launch more instances)
  if (numInstancesToLaunch > 0) {
    console.log(`Need to launch ${numInstancesToLaunch} new instance(s)`);
    await launchInstances(numInstancesToLaunch);
  }
  // Scale in (terminate excess instances)
  else if (queueLength === 0 && numRunningInstances > minInstances) {
    const instanceToTerminate = runningInstances[0]; // Terminate the first instance
    console.log(`Terminating instance: ${instanceToTerminate}`);
    await terminateInstance(instanceToTerminate);
  }
}

// Start the server
app.listen(port, () => {
  console.log(`Web Tier running on port ${port}`);
});

const autoscalingInterval = 5000; // 60 seconds

// Call autoscaleAppTier at regular intervals
setInterval(async () => {
  try {
    console.log("Running autoscaling check...");
    await autoscaleAppTier();
  } catch (error) {
    console.error("Error in autoscaling:", error);
  }
}, autoscalingInterval);

pollForResponses(); // Start polling for SQS messages
