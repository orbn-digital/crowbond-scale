const dgram = require("dgram");
const http = require("http");
const Ably = require("ably");

class XtremScale {
  constructor(scaleIP, localPort = 5555, remotePort = 4444) {
    this.scaleIP = scaleIP;
    this.localPort = localPort; // Port we bind to for receiving
    this.remotePort = remotePort; // Port we send to on the scale
    this.client = dgram.createSocket("udp4");
    this.weightData = null;
    this.isConnected = false;
    this.rxBuffer = "";
    this.streamingMode = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Handle incoming messages first
      this.client.on("message", (msg, rinfo) => {
        if (!this.streamingMode) {
          console.log(`Received from ${rinfo.address}:${rinfo.port}`);
        }
        this.handleMessage(msg.toString());
      });

      this.client.on("error", (err) => {
        console.error("UDP error:", err);
        this.isConnected = false;
        // Don't reject on error, just log it
      });

      // Bind to local port for receiving data
      this.client.bind(this.localPort, () => {
        console.log(`Listening on local port ${this.localPort}`);
        console.log(`Will send to ${this.scaleIP}:${this.remotePort}`);
        this.isConnected = true;
        resolve();
      });
    });
  }

  sendCommand(command) {
    const buffer = Buffer.from(command);
    return new Promise((resolve, reject) => {
      // Send to the scale with host and port specified
      this.client.send(buffer, this.remotePort, this.scaleIP, (err) => {
        if (err) {
          console.error("Send error:", err);
          reject(err);
        } else {
          if (!this.streamingMode) {
            console.log(
              `Sent command: ${command.replace(
                /[\u0002\u0003\r\n]/g,
                (match) => {
                  const replacements = {
                    "\u0002": "[STX]",
                    "\u0003": "[ETX]",
                    "\r": "[CR]",
                    "\n": "[LF]",
                  };
                  return replacements[match] || match;
                }
              )}`
            );
          }
          resolve();
        }
      });
    });
  }

  startStreaming() {
    // Start weight streaming command
    const startCmd = "\u000200FFE10110000\u0003\r\n";
    return this.sendCommand(startCmd);
  }

  stopStreaming() {
    // Stop weight streaming command
    const stopCmd = "\u000200FFE10100000\u0003\r\n";
    return this.sendCommand(stopCmd);
  }

  handleMessage(message) {
    // Only log in debug mode (not in streaming)
    if (!this.streamingMode) {
      console.log(`Received data from scale: ${message.length} bytes`);
      // Log hex representation for debugging
      const hexString = Buffer.from(message).toString("hex");
      console.log(`Hex: ${hexString}`);
    }

    this.rxBuffer += message;

    // Look for complete messages between STX and ETX
    while (
      this.rxBuffer.includes("\u0002") &&
      this.rxBuffer.includes("\u0003")
    ) {
      const stxIndex = this.rxBuffer.indexOf("\u0002");
      const etxIndex = this.rxBuffer.indexOf("\u0003", stxIndex);

      if (etxIndex > stxIndex) {
        // Extract complete message
        const completeMessage = this.rxBuffer.substring(stxIndex + 1, etxIndex);
        this.parseWeightData(completeMessage);

        // Remove processed message from buffer
        this.rxBuffer = this.rxBuffer.substring(etxIndex + 1);
      } else {
        break;
      }
    }

    // Alternative: The C# sometimes strips first char and last 3 chars
    // Try this if no STX/ETX found
    if (!this.rxBuffer.includes("\u0002") && this.rxBuffer.length > 4) {
      const strippedMessage = this.rxBuffer.substring(
        1,
        this.rxBuffer.length - 3
      );
      if (strippedMessage.length >= 15) {
        console.log(
          "Trying alternative parsing (no STX/ETX):",
          strippedMessage
        );
        this.parseWeightData(strippedMessage);
        this.rxBuffer = "";
      }
    }
  }

  parseWeightData(data) {
    // Log raw data for debugging (only if not streaming)
    if (!this.streamingMode) {
      console.log("Raw data received:", data);
    }

    // Based on the actual data received:
    // Format: 0100r01071AW   0.000kgT   0.0...
    // Or: 0100e101101054 (confirmation messages)

    if (data.length >= 15) {
      const address = data.substring(0, 2); // "01"
      const command = data.substring(2, 4); // "00"

      // Check if this is weight data or confirmation
      if (data.substring(4, 5) === "r") {
        // Weight data format: 0100r01071AW   0.000kgT   0.0...
        const weightString = data.substring(13, 24).trim(); // Extract weight value
        const unit = data.substring(24, 26).trim(); // Extract unit

        this.weightData = {
          raw: data,
          address: address,
          command: command,
          weight: weightString,
          unit: unit,
          timestamp: new Date(),
          display: `${weightString} ${unit}`,
        };

        if (!this.streamingMode) {
          console.log(`Weight: ${this.weightData.display}`);
        }
      } else if (data.substring(4, 5) === "e") {
        // Confirmation/status message
        if (!this.streamingMode) {
          console.log("Status message:", data);
        }
      } else {
        // Other data format
        this.weightData = {
          raw: data,
          address: address,
          command: command,
          payload: data.substring(4),
          timestamp: new Date(),
          display: data.substring(4),
        };
      }
    }
  }

  async getWeight(timeout = 5000) {
    // Clear previous weight data
    this.weightData = null;

    // Start streaming
    await this.startStreaming();
    console.log("Weight streaming started, waiting for data...");

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(async () => {
        await this.stopStreaming();
        if (!this.weightData) {
          reject(new Error("Timeout waiting for weight data"));
        }
      }, timeout);

      // Check for weight data
      const checkInterval = setInterval(async () => {
        if (this.weightData) {
          clearTimeout(timeoutId);
          clearInterval(checkInterval);
          await this.stopStreaming();
          console.log("Weight streaming stopped");
          resolve(this.weightData);
        }
      }, 100);
    });
  }

  async streamContinuous(reportFunc) {
    // Set streaming mode flag
    this.streamingMode = true;

    // Start streaming and keep it alive
    await this.startStreaming();
    console.log("Weight streaming started - continuous mode");
    console.log("Press Ctrl+C to stop\n");

    // Keep updating the display with latest weight
    let lastDisplay = "";
    setInterval(async () => {
      if (this.weightData && this.weightData.display !== lastDisplay) {
        lastDisplay = this.weightData.display;
        await reportFunc(lastDisplay);
      }
    }, 100);

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\n\nStopping weight stream...");
      await this.stopStreaming();
      await this.close();
      process.exit(0);
    });

    // Keep the process alive
    return new Promise(() => {});
  }

  async getParameters() {
    // Get scale parameters (simplified example)
    // Based on C# code, parameters use addresses like 0x00, 0x01, etc.
    const params = {};

    // Example: Get serial number (address 0x00)
    // Command format: STX + ID + Address + Command + Data + ETX + CRLF
    // This would need proper protocol implementation

    console.log(
      "Getting scale parameters would require protocol documentation"
    );
    return params;
  }

  async getScaleId() {
    try {
      const info = await this.getScaleIdentifier();
      this.serialNumber = info.serialNumber;
      return info.serialNumber;
    } catch (error) {
      console.error("Failed to get scale ID:", error.message);
      // Fallback: use IP address as identifier
      return this.scaleIP;
    }
  }

  async getScaleIdentifier() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.scaleIP,
        port: 80,
        path: "/",
        method: "GET",
        timeout: 3000,
      };

      const req = http.request(options, (res) => {
        if (res.statusCode === 401) {
          const authHeader = res.headers["www-authenticate"];
          if (authHeader) {
            const realmMatch = authHeader.match(/realm="([^"]+)"/);
            if (realmMatch && realmMatch[1]) {
              const realm = realmMatch[1];
              const serialNumber = realm.replace("XTREM", "");

              resolve({
                serialNumber: serialNumber,
                fullRealm: realm,
                identifier: serialNumber,
              });
            }
          }
        }

        res.on("data", () => {});
        res.on("end", () => {
          if (!res.headers["www-authenticate"]) {
            reject(new Error("No authentication realm found"));
          }
        });
      });

      req.on("error", (err) => {
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout"));
      });

      req.end();
    });
  }

  close() {
    return new Promise((resolve) => {
      if (this.isConnected) {
        this.stopStreaming().finally(() => {
          this.client.close(() => {
            console.log("Connection closed");
            this.isConnected = false;
            resolve();
          });
        });
      } else {
        resolve();
      }
    });
  }
}

class RealTimeScale {
  constructor(key, scaleId) {
    this.service = new Ably.Realtime(key);
    this.service.connection.once("connected", () =>
      console.log("Connected to realtime service")
    );
    this.channel = this.service.channels.get(`scale-${scaleId}`);
  }

  async updateWeight(weight) {
    await this.channel.publish("weight-update", {
      weight,
    });
  }

  close() {
    this.service.close();
  }
}

// Main function for testing
async function main() {
  // ably key
  const ablyKey = "kAcRJQ.Itic9A:84MidWkk8sUAw2vy_harnbxvYUsolsg4N3lgSPgAowI";

  // Get command line arguments
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(
      "Usage: node scale.js <IP_ADDRESS> [MODE] [LOCAL_PORT] [REMOTE_PORT]"
    );
    process.exit(1);
  }

  const scaleIP = args[0];
  let mode = "single";
  let localPort = 5555;
  let remotePort = 4444;

  // Parse arguments
  if (args[1]) {
    if (args[1] === "stream" || args[1] === "single") {
      mode = args[1];
      localPort = args[2] ? parseInt(args[2]) : 5555;
      remotePort = args[3] ? parseInt(args[3]) : 4444;
    } else {
      // Assume it's a port number for backward compatibility
      localPort = parseInt(args[1]);
      remotePort = args[2] ? parseInt(args[2]) : 4444;
    }
  }

  console.log(
    `Mode: ${mode === "stream" ? "Continuous streaming" : "Single reading"}`
  );

  const scale = new XtremScale(scaleIP, localPort, remotePort);

  try {
    // Connect to scale
    console.log("\nConnecting to scale...");
    await scale.connect();
    console.log("Successfully connected to scale!\n");

    const scaleId = await scale.getScaleId();
    console.log(`Scale ID: ${scaleId}`);

    const realTimeScale = new RealTimeScale(ablyKey, scaleId);

    if (mode === "stream") {
      // Continuous streaming mode
      const reportFunc = async (weight) => {
        await realTimeScale.updateWeight(weight);
        process.stdout.write(`\rCurrent weight: ${weight}     `);
      };
      await scale.streamContinuous(reportFunc);
    } else {
      // Single reading mode
      console.log("Requesting weight data...");
      const weight = await scale.getWeight();

      console.log("\n" + "=".repeat(50));
      console.log("Weight Data Received:");
      console.log("=".repeat(50));
      console.log("Raw:", weight.raw);
      console.log("Display:", weight.display);
      console.log("Timestamp:", weight.timestamp);

      await scale.close();
      console.log("\nTest completed");
    }
  } catch (error) {
    console.error("\nError:", error.message);
    await scale.close();
  }
}

// Export class for use as module
module.exports = XtremScale;

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
