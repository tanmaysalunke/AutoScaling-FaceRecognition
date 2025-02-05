# AWS Image Classification with Auto Scaling

## Project Overview
This project implements automated image classification using AWS infrastructure, focusing on Infrastructure as a Service (IaaS) and auto scaling. The solution is designed to leverage cloud-based scalability, efficiently processing and classifying images to ensure optimal resource management and performance.

## Key AWS Services Used
- **Amazon EC2**: Utilized for running image processing and classification tasks in a scalable, virtual computing environment.
- **Amazon S3**: Employed for storing and retrieving image data securely and efficiently.
- **AWS Auto Scaling**: Ensures that the number of Amazon EC2 instances adjusts automatically, according to the defined conditions, to maintain steady, predictable performance at the lowest possible cost.

## Architecture
The architecture includes the following components:
- EC2 instances for deploying application servers that perform image classification tasks.
- S3 buckets for persistent storage of images and classification results.
- Auto Scaling to handle load variations and improve cost management by automatically adjusting the number of active EC2 instances.
