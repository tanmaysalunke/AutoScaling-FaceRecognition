# Use a base image
FROM node:14

# Set environment variables
ENV AWS_ACCESS_KEY_ID=your-access-key-id
ENV AWS_SECRET_ACCESS_KEY=your-secret-access-key

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application source code, including the data folder
COPY . .

# Expose the port the app runs on
EXPOSE 80

# Run the server
CMD ["node", "web-tier.js"]
