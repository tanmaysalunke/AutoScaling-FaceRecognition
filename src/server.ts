import express, { Request, Response } from 'express';
import AWS from 'aws-sdk';
import multer from 'multer';
import fs from 'fs';
import path from 'path';

// Initialize the Express app
const app = express();
const port = 3000;

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
const amiId = 'ami-0866a3c8686eaeeba'; // Your App Tier AMI ID
const maxInstances = 20;
const minInstances = 0; // No instances when there are no pending messages
const instanceType = 't2.micro'; // Adjust as needed

// Function to scale out by launching new EC2 instances
async function scaleOut(currentInstanceCount: number, desiredInstances: number) {
    const instancesToLaunch = desiredInstances - currentInstanceCount;
    if (instancesToLaunch > 0) {
        const params = {
            ImageId: amiId,
            InstanceType: instanceType,
            MinCount: instancesToLaunch,
            MaxCount: instancesToLaunch,
            TagSpecifications: [{
                ResourceType: 'instance',
                Tags: [{ Key: 'Name', Value: 'app-tier-instance' }]
            }]
        };
        const result = await ec2.runInstances(params).promise();

        // Safely check if instances were launched and instanceIds are not undefined
        const instanceIds = result.Instances?.map(instance => instance.InstanceId);
        
        if (instanceIds && instanceIds.length > 0) {
            console.log(`${instancesToLaunch} EC2 instances launched with IDs: ${instanceIds.join(', ')}`);
        } else {
            console.log('No instances were launched.');
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
            Filters: [{ Name: 'tag:Name', Values: ['app-tier-instance'] }],
            MaxResults: instancesToTerminate
        };
        const instances = await ec2.describeInstances(params).promise();

        // Safely check for valid instance IDs
        const instanceIds = instances.Reservations
            ?.flatMap(res => res.Instances?.filter(instance => instance?.State?.Name === 'running').map(inst => inst.InstanceId))
            ?.filter((id): id is string => id !== undefined); // Type narrowing to filter out undefined

        if (instanceIds && instanceIds.length > 0) {
            await ec2.terminateInstances({ InstanceIds: instanceIds }).promise();
            console.log(`${instancesToTerminate} EC2 instances terminated with IDs: ${instanceIds.join(', ')}`);
        } else {
            console.log('No valid instance IDs found to terminate.');
        }
    } else {
        console.log('No scaling in required.');
    }
}

// Function to monitor SQS and scale in/out EC2 instances accordingly
async function autoscale() {
    const params = {
        QueueUrl: requestQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages']
    };

    const result = await sqs.getQueueAttributes(params).promise();
    const pendingMessages = parseInt(result.Attributes?.ApproximateNumberOfMessages || '0', 10);
    console.log(`Pending messages in queue: ${pendingMessages}`);

    // Get the current number of running App Tier instances
    const ec2Params = {
        Filters: [{ Name: 'tag:Name', Values: ['app-tier-instance'] }],
        MaxResults: 50 // Use a larger number to ensure all instances are retrieved
    };

    const instanceData = await ec2.describeInstances(ec2Params).promise();
    const currentInstanceCount = instanceData.Reservations
        ?.flatMap(res => res.Instances)
        ?.filter(instance => instance?.State?.Name === 'running').length || 0;

    console.log(`Current App Tier instance count: ${currentInstanceCount}`);

    // Define thresholds for scaling
    const scaleOutThreshold = 10;
    const scaleInThreshold = 3;

    if (pendingMessages > scaleOutThreshold && currentInstanceCount < maxInstances) {
        // Scale out: increase the number of instances
        const desiredInstances = Math.min(maxInstances, currentInstanceCount + Math.ceil(pendingMessages / scaleOutThreshold));
        await scaleOut(currentInstanceCount, desiredInstances);
    } else if (pendingMessages < scaleInThreshold && currentInstanceCount > minInstances) {
        // Scale in: decrease the number of instances
        const desiredInstances = Math.max(minInstances, Math.ceil(pendingMessages / scaleInThreshold));
        await scaleIn(currentInstanceCount, desiredInstances);
    } else {
        console.log('No scaling action required.');
    }
}

// Periodically run autoscaling logic
setInterval(autoscale, 5 * 1000); // Runs every 5 seconds

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

    const fileContent = fs.readFileSync(req.file.path).toString('base64');  // Encode image as base64
    fs.unlinkSync(req.file.path); // Delete the uploaded file immediately after reading

    const sqsParams = {
        QueueUrl: requestQueueUrl,
        MessageBody: JSON.stringify({
            fileName: baseFileName,  // Use the base file name without extension for the message
            fileContent
        })
    };

    await sqs.sendMessage(sqsParams).promise();
    console.log(`Sent image ${fileName} to the request queue`);

    const receiveParams = {
        QueueUrl: responseQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20
    };

    try {
        while (true) {
            const response = await sqs.receiveMessage(receiveParams).promise();
            if (response.Messages && response.Messages.length > 0) {
                const message = response.Messages[0];
                if (message.Body && message.ReceiptHandle) {
                    const result = JSON.parse(message.Body);

                    if (result.fileName === baseFileName) {
                        await sqs.deleteMessage({
                            QueueUrl: responseQueueUrl,
                            ReceiptHandle: message.ReceiptHandle
                        }).promise();
                        console.log(`Deleted message with ReceiptHandle: ${message.ReceiptHandle}`);
                        res.send(`${result.fileName}:${result.classificationResult}`); // Ensure no space after colon
                        return;
                    }
                }
            } else {
                console.log("No response received, continuing to poll...");
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before polling again
            }
        }
    } catch (error) {
        console.error('Error processing image request:', error);
        res.status(500).send('Error processing request');
    }
});

// Start the Express server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
