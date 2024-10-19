# Use a base image
FROM node:14

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application source code, including the data folder
COPY . .

# Ensure the data folder is copied to the container
COPY data ./data

# Expose the port the app runs on
EXPOSE 80

# Run the server
CMD ["node", "dist/server.js"]
