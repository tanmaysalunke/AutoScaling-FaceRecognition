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
const amiId = 'ami-0866a3c8686eaeeba'; // Your App Tier AMI ID
const maxInstances = 20;
const minInstances = 0; // No instances when there are no pending messages
const instanceType = 't2.micro'; // Adjust as needed
// Function to scale out by launching new EC2 instances
function scaleOut(currentInstanceCount, desiredInstances) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
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
            // Safely check if instances were launched and instanceIds are not undefined
            const instanceIds = (_a = result.Instances) === null || _a === void 0 ? void 0 : _a.map(instance => instance.InstanceId);
            if (instanceIds && instanceIds.length > 0) {
                console.log(`${instancesToLaunch} EC2 instances launched with IDs: ${instanceIds.join(', ')}`);
            }
            else {
                console.log('No instances were launched.');
            }
        }
        else {
            console.log('No scaling out required.');
        }
    });
}
// Function to scale in by terminating EC2 instances
function scaleIn(currentInstanceCount, desiredInstances) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const instancesToTerminate = currentInstanceCount - desiredInstances;
        if (instancesToTerminate > 0) {
            const params = {
                Filters: [{ Name: 'tag:Name', Values: ['app-tier-instance'] }]
            };
            const instances = yield ec2.describeInstances(params).promise();
            // Flatten the instances and filter for running instances
            const instanceIds = (_b = (_a = instances.Reservations) === null || _a === void 0 ? void 0 : _a.flatMap(res => { var _a; return (_a = res.Instances) === null || _a === void 0 ? void 0 : _a.filter(instance => { var _a; return ((_a = instance === null || instance === void 0 ? void 0 : instance.State) === null || _a === void 0 ? void 0 : _a.Name) === 'running'; }).map(inst => inst.InstanceId); })) === null || _b === void 0 ? void 0 : _b.filter((id) => id !== undefined);
            if (instanceIds && instanceIds.length > 0) {
                const terminateInstanceIds = instanceIds.slice(0, instancesToTerminate);
                yield ec2.terminateInstances({ InstanceIds: terminateInstanceIds }).promise();
                console.log(`${terminateInstanceIds.length} EC2 instances terminated with IDs: ${terminateInstanceIds.join(', ')}`);
            }
            else {
                console.log('No valid instance IDs found to terminate.');
            }
        }
        else {
            console.log('No scaling in required.');
        }
    });
}
// Function to monitor SQS and scale in/out EC2 instances accordingly
function autoscale() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
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
            MaxResults: 50 // Use a larger number to ensure all instances are retrieved
        };
        const instanceData = yield ec2.describeInstances(ec2Params).promise();
        const currentInstanceCount = ((_c = (_b = instanceData.Reservations) === null || _b === void 0 ? void 0 : _b.flatMap(res => res.Instances)) === null || _c === void 0 ? void 0 : _c.filter(instance => { var _a; return ((_a = instance === null || instance === void 0 ? void 0 : instance.State) === null || _a === void 0 ? void 0 : _a.Name) === 'running'; }).length) || 0;
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
        else {
            console.log('No scaling action required.');
        }
    });
}
// Periodically run autoscaling logic
setInterval(autoscale, 5 * 1000); // Runs every 5 seconds
// Define root directory relative to the current file (even in dist)
const rootDir = path_1.default.resolve(__dirname, '..');
// Multer setup for handling file uploads (now relative to project root)
const upload = (0, multer_1.default)({ dest: path_1.default.join(rootDir, 'uploads/') });
// POST request handler for receiving images
app.post('/', upload.single('inputFile'), (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (!req.file) {
        res.status(400).send('No file uploaded');
        return;
    }
    // Remove file extension for consistent naming
    const fileName = req.file.originalname;
    const baseFileName = path_1.default.basename(fileName, path_1.default.extname(fileName));
    const fileContent = fs_1.default.readFileSync(req.file.path).toString('base64'); // Encode image as base64
    fs_1.default.unlinkSync(req.file.path); // Delete the uploaded file immediately after reading
    const sqsParams = {
        QueueUrl: requestQueueUrl,
        MessageBody: JSON.stringify({
            fileName: baseFileName, // Use the base file name without extension for the message
            fileContent
        })
    };
    yield sqs.sendMessage(sqsParams).promise();
    console.log(`Sent image ${fileName} to the request queue`);
    const receiveParams = {
        QueueUrl: responseQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20
    };
    try {
        while (true) {
            const response = yield sqs.receiveMessage(receiveParams).promise();
            if (response.Messages && response.Messages.length > 0) {
                const message = response.Messages[0];
                if (message.Body && message.ReceiptHandle) {
                    const result = JSON.parse(message.Body);
                    if (result.fileName === baseFileName) {
                        yield sqs.deleteMessage({
                            QueueUrl: responseQueueUrl,
                            ReceiptHandle: message.ReceiptHandle
                        }).promise();
                        console.log(`Deleted message with ReceiptHandle: ${message.ReceiptHandle}`);
                        res.send(`${result.fileName}:${result.classificationResult}`); // Ensure no space after colon
                        return;
                    }
                }
            }
            else {
                console.log("No response received, continuing to poll...");
                yield new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before polling again
            }
        }
    }
    catch (error) {
        console.error('Error processing image request:', error);
        res.status(500).send('Error processing request');
    }
}));
// Start the Express server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
