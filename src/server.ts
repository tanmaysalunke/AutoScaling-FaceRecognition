import express, { Request, Response } from 'express';
import AWS from 'aws-sdk';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';

// Load the .env file
dotenv.config();

// Initialize the Express app
const app = express();
const port = 80;

// AWS Configuration
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, // Access key
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, // Secret key
    region: 'us-east-1'
});

const ec2 = new AWS.EC2();
const sqs = new AWS.SQS();

const ASU_ID = '1229850390';
const requestQueueUrl = `https://sqs.us-east-1.amazonaws.com/442042549532/${ASU_ID}-req-queue`;
const responseQueueUrl = `https://sqs.us-east-1.amazonaws.com/442042549532/${ASU_ID}-resp-queue`;
const amiId = 'ami-04106cfbfa4d9bbf6'; // Your App Tier AMI ID
const maxInstances = 20;
const minInstances = 0; // No instances when there are no pending messages
const instanceType = 't2.micro'; // Adjust as needed

const pendingRequests = new Map();

// Function to scale out by launching EC2 instances
async function scaleOut(currentInstanceCount: number, desiredInstances: number) {
    const instancesToLaunch = desiredInstances - currentInstanceCount;
    if (instancesToLaunch > 0) {
        const params = {
            ImageId: amiId,
            InstanceType: instanceType,
            MinCount: instancesToLaunch,
            MaxCount: instancesToLaunch,
            KeyName: 'project2',
            SecurityGroupIds: ['sg-0273f2abaf816cfe1'],
            TagSpecifications: [{
                ResourceType: 'instance',
                Tags: [{ Key: 'Name', Value: 'app-tier-instance' }]
            }],
            UserData: Buffer.from(`#!/bin/bash
                sudo docker run -d -e AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} -e AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} -e AWS_REGION=${process.env.AWS_REGION} tanmaysalunke/apptier:latest`).toString('base64')
        };
        try {
            const result = await ec2.runInstances(params).promise();
            const instanceIds = result.Instances?.map(instance => instance.InstanceId);

            if (instanceIds && instanceIds.length > 0) {
                console.log(`${instancesToLaunch} EC2 instances launched with IDs: ${instanceIds.join(', ')}`);
            } else {
                console.log('No instances were launched.');
            }
        } catch (error) {
            console.error('Error launching instances:', error);
        }
    } else {
        console.log('No scaling out required.');
    }
}

// Function to scale in by terminating EC2 instances
async function scaleIn(currentInstanceCount: number, desiredInstances: number) {
    const instancesToTerminate = currentInstanceCount - desiredInstances;

    if (instancesToTerminate > 0) {
        const params = {
            Filters: [{ Name: 'tag:Name', Values: ['app-tier-instance'] }]
        };
        try {
            const instances = await ec2.describeInstances(params).promise();
            const instanceIds = instances.Reservations
                ?.flatMap(res => res.Instances)
                ?.filter(instance => instance?.State?.Name === 'running')
                .map(instance => instance?.InstanceId)
                .filter((id): id is string => id !== undefined);

            if (instanceIds && instanceIds.length > 0) {
                console.log(`Terminating all instances: ${instanceIds.join(', ')}`);
                await ec2.terminateInstances({ InstanceIds: instanceIds }).promise();
                console.log(`All EC2 instances terminated.`);
            } else {
                console.log('No instances found to terminate.');
            }
        } catch (error) {
            console.error('Error terminating instances:', error);
        }
    } else {
        console.log('No scaling in required.');
    }
}

const COOLDOWN_PERIOD = 30000; // 30 seconds in milliseconds
let lastScaleTime = 0; // Timestamp of the last scaling action
let lastMessageTime = Date.now(); // Timestamp when the last message was processed

async function autoscale() {
    console.log("Running auto scaling");
    const result = await sqs.getQueueAttributes({
        QueueUrl: requestQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages']
    }).promise();

    const pendingMessages = parseInt(result.Attributes?.ApproximateNumberOfMessages || '0', 10);
    const now = Date.now();
    const timeSinceLastMessage = now - lastMessageTime;
    const timeSinceLastScale = now - lastScaleTime;

    const ec2Params = { 
        Filters: [{ Name: 'tag:Name', Values: ['app-tier-instance'] }],
        MaxResults: 50
    };

    const instanceData = await ec2.describeInstances(ec2Params).promise();
    const currentInstanceCount = instanceData.Reservations
        ?.flatMap(res => res.Instances)
        ?.filter(instance => instance?.State?.Name === 'running').length || 0;

    console.log(`Pending messages in queue: ${pendingMessages}`);
    console.log(`Current App Tier instance count: ${currentInstanceCount}`);

    if (pendingMessages > 0) {
        lastMessageTime = now;  // Update the last message time
        const desiredInstances = Math.min(maxInstances, Math.ceil(pendingMessages / 10));  // Assuming one instance can handle 10 messages   
        if (desiredInstances > currentInstanceCount && timeSinceLastScale > COOLDOWN_PERIOD) {
            console.log(`Scaling out to ${desiredInstances} instances.`);
            await scaleOut(currentInstanceCount, desiredInstances);
            lastScaleTime = Date.now();  // Update the last scale time
        } else {
            console.log('Desired instances are less than or equal to current instances. No scaling out required.');
        }
    } else if (pendingMessages === 0 && currentInstanceCount > 0 && timeSinceLastMessage > COOLDOWN_PERIOD && timeSinceLastScale > COOLDOWN_PERIOD) {
        console.log('Queue is empty and cooldown period has passed. Terminating all instances.');
        await scaleIn(currentInstanceCount, 0);
        lastScaleTime = Date.now();  // Update the last scale time
    } else {
        console.log('No scaling action required or waiting for cooldown period to pass.');
    }
}

setInterval(autoscale, 5000); // Periodically run autoscaling logic every 5 seconds

// Define root directory relative to the current file (even in dist)
const rootDir = path.resolve(__dirname, '..');

// Multer setup for handling file uploads (now relative to project root)
const upload = multer({ dest: path.join(rootDir, 'uploads/') });

// POST request handler for receiving images
app.post('/', upload.single('inputFile'), async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
        res.status(400).send('No file uploaded');
        return;
    }

    // Remove file extension for consistent naming
    const fileName = req.file.originalname;
    const baseFileName = path.basename(fileName, path.extname(fileName));
    
    fs.unlinkSync(req.file.path); // Delete the uploaded file immediately after reading

    const sqsParams = {
        QueueUrl: requestQueueUrl,
        MessageBody: JSON.stringify({
            imageKey: req.file.originalname,
            imageContent: fs.readFileSync(req.file.path).toString("base64"),
        })
    };
    const requestId = baseFileName;
    try {
        await sqs.sendMessage(sqsParams).promise();
        console.log(`Sent image ${fileName} to the request queue`);

        // Wait for the classification result or timeout
        const result = await new Promise<string>((resolve, reject) => {
            // Register the resolve function in a map with the request ID
            pendingRequests.set(requestId, resolve);

            // Optionally handle result not being available yet here,
            // for example by checking after a long period or handling this via another route or system
        });

        // Send the result back to the client
        res.send(`${baseFileName}:${result}`);
    } catch (error: unknown) {
        if (error instanceof Error) {
            console.error('Error processing request:', error.message);
            res.status(500).send(`Error processing request: ${error.message}`);
        } else {
            console.error('Unexpected error:', error);
            res.status(500).send('An unexpected error occurred');
        }
    }
});

async function pollResponseQueue() {
    while (true) {
      console.log("Polling for messages");
      try {
        const receiveParams = {
            QueueUrl: responseQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 10,
        };

        const response = await sqs.receiveMessage(receiveParams).promise();
  
        if (response.Messages) {
          for (const message of response.Messages) {
            const responseBody = JSON.parse(message.Body || "{}");
            // const { requestId, classificationResult } = responseBody;
            const requestId = responseBody.fileName;
            const classificationResult = responseBody.classificationResult;
            // Check if we have a pending request with this requestId
            const resolve = pendingRequests.get(requestId);
            if (resolve) {
              console.log("Message Resolving");
              // Resolve the Promise to unblock the request handler
              resolve(classificationResult);
              pendingRequests.delete(requestId);
              console.log("Message Resolved");
              if (message.ReceiptHandle) {
                    await sqs.deleteMessage({
                        QueueUrl: responseQueueUrl,
                        ReceiptHandle: message.ReceiptHandle
                    }).promise();
                } else {
                    console.error("ReceiptHandle is undefined, cannot delete message");
                }
            }
          }
        }
      } catch (error) {
        console.error("Error polling response queue:", error);
        }
    }
}

// Start the Express server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    pollResponseQueue();
});
