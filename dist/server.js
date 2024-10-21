"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
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
const dotenv = __importStar(require("dotenv"));
// Load the .env file
dotenv.config();
// Initialize the Express app
const app = (0, express_1.default)();
const port = 80;
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
const amiId = 'ami-04106cfbfa4d9bbf6'; // Your App Tier AMI ID
const maxInstances = 20;
const minInstances = 0; // No instances when there are no pending messages
const instanceType = 't2.micro'; // Adjust as needed
const pendingRequests = new Map();
// Function to scale out by launching EC2 instances
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
                const result = yield ec2.runInstances(params).promise();
                const instanceIds = (_a = result.Instances) === null || _a === void 0 ? void 0 : _a.map(instance => instance.InstanceId);
                if (instanceIds && instanceIds.length > 0) {
                    console.log(`${instancesToLaunch} EC2 instances launched with IDs: ${instanceIds.join(', ')}`);
                }
                else {
                    console.log('No instances were launched.');
                }
            }
            catch (error) {
                console.error('Error launching instances:', error);
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
            try {
                const instances = yield ec2.describeInstances(params).promise();
                const instanceIds = (_b = (_a = instances.Reservations) === null || _a === void 0 ? void 0 : _a.flatMap(res => res.Instances)) === null || _b === void 0 ? void 0 : _b.filter(instance => { var _a; return ((_a = instance === null || instance === void 0 ? void 0 : instance.State) === null || _a === void 0 ? void 0 : _a.Name) === 'running'; }).map(instance => instance === null || instance === void 0 ? void 0 : instance.InstanceId).filter((id) => id !== undefined);
                if (instanceIds && instanceIds.length > 0) {
                    console.log(`Terminating all instances: ${instanceIds.join(', ')}`);
                    yield ec2.terminateInstances({ InstanceIds: instanceIds }).promise();
                    console.log(`All EC2 instances terminated.`);
                }
                else {
                    console.log('No instances found to terminate.');
                }
            }
            catch (error) {
                console.error('Error terminating instances:', error);
            }
        }
        else {
            console.log('No scaling in required.');
        }
    });
}
const COOLDOWN_PERIOD = 30000; // 30 seconds in milliseconds
let lastScaleTime = 0; // Timestamp of the last scaling action
let lastMessageTime = Date.now(); // Timestamp when the last message was processed
function autoscale() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        console.log("Running auto scaling");
        const result = yield sqs.getQueueAttributes({
            QueueUrl: requestQueueUrl,
            AttributeNames: ['ApproximateNumberOfMessages']
        }).promise();
        const pendingMessages = parseInt(((_a = result.Attributes) === null || _a === void 0 ? void 0 : _a.ApproximateNumberOfMessages) || '0', 10);
        const now = Date.now();
        const timeSinceLastMessage = now - lastMessageTime;
        const timeSinceLastScale = now - lastScaleTime;
        const ec2Params = {
            Filters: [{ Name: 'tag:Name', Values: ['app-tier-instance'] }],
            MaxResults: 50
        };
        const instanceData = yield ec2.describeInstances(ec2Params).promise();
        const currentInstanceCount = ((_c = (_b = instanceData.Reservations) === null || _b === void 0 ? void 0 : _b.flatMap(res => res.Instances)) === null || _c === void 0 ? void 0 : _c.filter(instance => { var _a; return ((_a = instance === null || instance === void 0 ? void 0 : instance.State) === null || _a === void 0 ? void 0 : _a.Name) === 'running'; }).length) || 0;
        console.log(`Pending messages in queue: ${pendingMessages}`);
        console.log(`Current App Tier instance count: ${currentInstanceCount}`);
        if (pendingMessages > 0) {
            lastMessageTime = now; // Update the last message time
            const desiredInstances = Math.min(maxInstances, Math.ceil(pendingMessages / 10)); // Assuming one instance can handle 10 messages   
            if (desiredInstances > currentInstanceCount && timeSinceLastScale > COOLDOWN_PERIOD) {
                console.log(`Scaling out to ${desiredInstances} instances.`);
                yield scaleOut(currentInstanceCount, desiredInstances);
                lastScaleTime = Date.now(); // Update the last scale time
            }
            else {
                console.log('Desired instances are less than or equal to current instances. No scaling out required.');
            }
        }
        else if (pendingMessages === 0 && currentInstanceCount > 0 && timeSinceLastMessage > COOLDOWN_PERIOD && timeSinceLastScale > COOLDOWN_PERIOD) {
            console.log('Queue is empty and cooldown period has passed. Terminating all instances.');
            yield scaleIn(currentInstanceCount, 0);
            lastScaleTime = Date.now(); // Update the last scale time
        }
        else {
            console.log('No scaling action required or waiting for cooldown period to pass.');
        }
    });
}
setInterval(autoscale, 5000); // Periodically run autoscaling logic every 5 seconds
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
    fs_1.default.unlinkSync(req.file.path); // Delete the uploaded file immediately after reading
    const sqsParams = {
        QueueUrl: requestQueueUrl,
        MessageBody: JSON.stringify({
            imageKey: req.file.originalname,
            imageContent: fs_1.default.readFileSync(req.file.path).toString("base64"),
        })
    };
    const requestId = baseFileName;
    try {
        yield sqs.sendMessage(sqsParams).promise();
        console.log(`Sent image ${fileName} to the request queue`);
        // Wait for the classification result or timeout
        const result = yield new Promise((resolve, reject) => {
            // Register the resolve function in a map with the request ID
            pendingRequests.set(requestId, resolve);
            // Optionally handle result not being available yet here,
            // for example by checking after a long period or handling this via another route or system
        });
        // Send the result back to the client
        res.send(`${baseFileName}:${result}`);
    }
    catch (error) {
        if (error instanceof Error) {
            console.error('Error processing request:', error.message);
            res.status(500).send(`Error processing request: ${error.message}`);
        }
        else {
            console.error('Unexpected error:', error);
            res.status(500).send('An unexpected error occurred');
        }
    }
}));
function pollResponseQueue() {
    return __awaiter(this, void 0, void 0, function* () {
        while (true) {
            console.log("Polling for messages");
            try {
                const receiveParams = {
                    QueueUrl: responseQueueUrl,
                    MaxNumberOfMessages: 10,
                    WaitTimeSeconds: 10,
                };
                const response = yield sqs.receiveMessage(receiveParams).promise();
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
                                yield sqs.deleteMessage({
                                    QueueUrl: responseQueueUrl,
                                    ReceiptHandle: message.ReceiptHandle
                                }).promise();
                            }
                            else {
                                console.error("ReceiptHandle is undefined, cannot delete message");
                            }
                        }
                    }
                }
            }
            catch (error) {
                console.error("Error polling response queue:", error);
            }
        }
    });
}
// Start the Express server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    pollResponseQueue();
});
