"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const aws_sdk_1 = __importDefault(require("aws-sdk"));
const multer_1 = __importDefault(require("multer"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Initialize the Express app
const app = (0, express_1.default)();
const port = 3000;
// AWS Configuration
aws_sdk_1.default.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, // Access key
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, // Secret key
    region: 'us-east-1'
});
const ec2 = new aws_sdk_1.default.EC2();
const sqs = new aws_sdk_1.default.SQS();
const ASU_ID = '1229850390';
const requestQueueUrl = `https://sqs.us-east-1.amazonaws.com/442042549532/${ASU_ID}-req-queue`;
const responseQueueUrl = `https://sqs.us-east-1.amazonaws.com/442042549532/${ASU_ID}-resp-queue`;
const amiId = 'ami-0df697fe14ff99106'; // Your App Tier AMI ID
const maxInstances = 20;
const minInstances = 0; // No instances when there are no pending messages
const instanceType = 't2.micro'; // Adjust as needed
// Function to scale out by launching new EC2 instances
function scaleOut(currentInstanceCount, desiredInstances) {
    return __awaiter(this, void 0, void 0, function* () {
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
            const result = yield ec2.runInstances(params).promise();
            console.log(`${instancesToLaunch} EC2 instances launched.`);
        }
    });
}
// Function to scale in by terminating EC2 instances
function scaleIn(currentInstanceCount, desiredInstances) {
    return __awaiter(this, void 0, void 0, function* () {
        const instancesToTerminate = currentInstanceCount - desiredInstances;
        if (instancesToTerminate > 0) {
            const params = {
                Filters: [{ Name: 'tag:Name', Values: ['app-tier-instance'] }],
                MaxResults: instancesToTerminate
            };
            const instances = yield ec2.describeInstances(params).promise();
            // Check if instances.Reservations is defined and not empty
            if (instances.Reservations && instances.Reservations.length > 0) {
                // Collect valid instance IDs and filter out undefined ones
                const instanceIds = instances.Reservations
                    .flatMap(res => { var _a; return (_a = res.Instances) === null || _a === void 0 ? void 0 : _a.map(inst => inst.InstanceId); })
                    .filter((id) => id !== undefined); // Type narrowing to filter out undefined
                if (instanceIds.length > 0) {
                    yield ec2.terminateInstances({ InstanceIds: instanceIds }).promise();
                    console.log(`${instancesToTerminate} EC2 instances terminated.`);
                }
                else {
                    console.log('No valid instance IDs found to terminate.');
                }
            }
            else {
                console.log('No instances found to terminate.');
            }
        }
    });
}
// Function to monitor SQS and scale in/out EC2 instances accordingly
function autoscale() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const params = {
            QueueUrl: requestQueueUrl,
            AttributeNames: ['ApproximateNumberOfMessages']
        };
        const result = yield sqs.getQueueAttributes(params).promise();
        const pendingMessages = parseInt(((_a = result.Attributes) === null || _a === void 0 ? void 0 : _a.ApproximateNumberOfMessages) || '0', 10);
        console.log(`Pending messages in queue: ${pendingMessages}`);
        // Get the current number of running App Tier instances
        const ec2Params = {
            Filters: [{ Name: 'tag:Name', Values: ['app-tier-instance'] }],
            MaxResults: 20
        };
        const instanceData = yield ec2.describeInstances(ec2Params).promise();
        // Check if Reservations exists and has content
        const currentInstanceCount = instanceData.Reservations && instanceData.Reservations.length > 0
            ? instanceData.Reservations.length
            : 0;
        console.log(`Current App Tier instance count: ${currentInstanceCount}`);
        // Define thresholds for scaling
        const scaleOutThreshold = 10;
        const scaleInThreshold = 3;
        if (pendingMessages > scaleOutThreshold && currentInstanceCount < maxInstances) {
            // Scale out: increase the number of instances
            const desiredInstances = Math.min(maxInstances, currentInstanceCount + Math.ceil(pendingMessages / scaleOutThreshold));
            yield scaleOut(currentInstanceCount, desiredInstances);
        }
        else if (pendingMessages < scaleInThreshold && currentInstanceCount > minInstances) {
            // Scale in: decrease the number of instances
            const desiredInstances = Math.max(minInstances, Math.ceil(pendingMessages / scaleInThreshold));
            yield scaleIn(currentInstanceCount, desiredInstances);
        }
    });
}
// Periodically run autoscaling logic
setInterval(autoscale, 60 * 1000); // Runs every 60 seconds
// Define root directory relative to the current file (even in dist)
const rootDir = path_1.default.resolve(__dirname, '..');
// Multer setup for handling file uploads (now relative to project root)
const upload = (0, multer_1.default)({ dest: path_1.default.join(rootDir, 'uploads/') });
// POST request handler for receiving images
app.post('/', upload.single('inputFile'), (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        if (!req.file) {
            res.status(400).send('No file uploaded');
            return;
        }
        const fileName = req.file.originalname;
        const fileContent = fs_1.default.readFileSync(req.file.path).toString('base64'); // Encode image as base64
        // Send message to SQS Request Queue with the base64-encoded image
        const sqsParams = {
            QueueUrl: requestQueueUrl,
            MessageBody: JSON.stringify({
                fileName,
                fileContent // Include base64-encoded image in the SQS message
            })
        };
        yield sqs.sendMessage(sqsParams).promise();
        console.log(`Sent image ${fileName} to the request queue`);
        // Poll for the response from the App Tier using the Response Queue
        const receiveParams = {
            QueueUrl: responseQueueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20
        };
        let receivedMessage;
        while (!receivedMessage) {
            const response = yield sqs.receiveMessage(receiveParams).promise();
            if (response.Messages && response.Messages.length > 0) {
                const message = response.Messages[0];
                receivedMessage = message;
                // Check if ReceiptHandle exists before attempting to delete
                if (message.ReceiptHandle) {
                    // Delete the message from the response queue after processing
                    yield sqs.deleteMessage({
                        QueueUrl: responseQueueUrl,
                        ReceiptHandle: message.ReceiptHandle
                    }).promise();
                    console.log(`Deleted message with ReceiptHandle: ${message.ReceiptHandle}`);
                }
                else {
                    console.error('ReceiptHandle is missing. Cannot delete message.');
                }
                // Parse the response message and send it back to the user
                const result = JSON.parse(message.Body);
                res.send(`${result.fileName}: ${result.classificationResult}`);
                return;
            }
        }
    }
    catch (error) {
        console.error('Error processing image request:', error);
        res.status(500).send('Error processing request');
    }
    finally {
        // Clean up uploaded file
        if (req.file) {
            fs_1.default.unlinkSync(req.file.path);
        }
    }
}));
// Start the Express server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
