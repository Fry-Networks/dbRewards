#!/usr/bin/env node
/**
 * Interactive CLI for managing hardware validation exceptions.
 *
 * Capabilities:
 *   • Add an exception (sets `rewards_exception.enabled` with auditing metadata).
 *   • Remove an exception.
 *   • List all active/expired exceptions.
 *   • Check the exception status for a specific miner key.
 *
 * Running:
 *   npm run exceptions            # connect to production DB
 *   npm run exceptions:test       # connect to test DB (sets TEST_MODE=true)
 *
 * Environment:
 *   Uses the same connection settings as the application via `db/connect`.
 *   Set TEST_MODE=true to target the test collections (`test-devices`).
 */

import { connect } from "../db/connect";
import { DeviceModel, TestDeviceModel, Device } from "../db/devices-schema";
import * as readline from "readline";
import { logSection } from "../logger";

const testMode = process.env.TEST_MODE === "true";
const Model = testMode ? TestDeviceModel : DeviceModel;

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Promisified question function
function question(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, resolve);
  });
}

// Clear screen helper
function clearScreen() {
  console.clear();
}

// Display menu
function displayMenu() {
  console.log("\n" + "=".repeat(60));
  console.log("   HARDWARE VALIDATION EXCEPTION MANAGER");
  console.log("=".repeat(60));
  console.log("\nOptions:");
  console.log("  1) Add Exception");
  console.log("  2) Remove Exception");
  console.log("  3) List All Exceptions");
  console.log("  4) Check Device Exception Status");
  console.log("  5) Exit");
  console.log("\n" + "=".repeat(60));
}

// Add exception
async function addException() {
  console.log("\n" + "-".repeat(60));
  console.log("ADD HARDWARE VALIDATION EXCEPTION");
  console.log("-".repeat(60) + "\n");

  const minerKey = await question("Enter miner key: ");
  
  if (!minerKey || minerKey.trim() === "") {
    console.log("❌ Error: Miner key cannot be empty");
    return;
  }

  // Check if device exists
  const device = await Model.findOne({ miner_key: minerKey.trim() });
  
  if (!device) {
    console.log(`❌ Error: Device '${minerKey}' not found in ${testMode ? "test" : "production"} database`);
    return;
  }

  // Check if exception already exists
  if (device.rewards_exception?.enabled) {
    console.log(`\n⚠️  Warning: This device already has an active exception:`);
    console.log(`   Reason: ${device.rewards_exception.reason || "N/A"}`);
    console.log(`   Added by: ${device.rewards_exception.added_by || "N/A"}`);
    console.log(`   Added at: ${device.rewards_exception.added_at?.toISOString() || "N/A"}`);
    if (device.rewards_exception.expires_at) {
      console.log(`   Expires: ${device.rewards_exception.expires_at.toISOString()}`);
    }
    
    const overwrite = await question("\nDo you want to overwrite it? (yes/no): ");
    if (overwrite.toLowerCase() !== "yes" && overwrite.toLowerCase() !== "y") {
      console.log("Operation cancelled.");
      return;
    }
  }

  const reason = await question("\nEnter reason for exception (required): ");
  
  if (!reason || reason.trim() === "") {
    console.log("❌ Error: Reason is required for audit purposes");
    return;
  }

  const addedBy = await question("Enter your name/ID: ");
  
  if (!addedBy || addedBy.trim() === "") {
    console.log("❌ Error: Added by field is required for audit purposes");
    return;
  }

  const expiresInput = await question("\nSet expiration? (leave empty for no expiration, or enter days): ");
  
  let expiresAt: Date | undefined;
  if (expiresInput && expiresInput.trim() !== "") {
    const days = parseInt(expiresInput);
    if (isNaN(days) || days <= 0) {
      console.log("❌ Error: Invalid number of days");
      return;
    }
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);
  }

  // Update device with exception
  try {
    const now = new Date();
    device.rewards_exception = {
      enabled: true,
      reason: reason.trim(),
      added_by: addedBy.trim(),
      added_at: now,
      expires_at: expiresAt,
    };

    await device.save();

    // Log to audit trail
    logSection(
      `🔐 Hardware Validation Exception ADDED`,
      `Miner Key: ${minerKey}`,
      `Reason: ${reason.trim()}`,
      `Added By: ${addedBy.trim()}`,
      `Added At: ${now.toISOString()}`,
      expiresAt ? `Expires: ${expiresAt.toISOString()}` : `Expires: Never`
    );

    console.log("\n" + "=".repeat(60));
    console.log("✅ Exception added successfully!");
    console.log("=".repeat(60));
    console.log(`Miner Key: ${minerKey}`);
    console.log(`Reason: ${reason.trim()}`);
    console.log(`Added By: ${addedBy.trim()}`);
    console.log(`Added At: ${now.toISOString()}`);
    if (expiresAt) {
      console.log(`Expires: ${expiresAt.toISOString()}`);
    } else {
      console.log(`Expires: Never`);
    }
    console.log("=".repeat(60));
  } catch (error) {
    console.log(`❌ Error saving exception: ${error}`);
  }
}

// Remove exception
async function removeException() {
  console.log("\n" + "-".repeat(60));
  console.log("REMOVE HARDWARE VALIDATION EXCEPTION");
  console.log("-".repeat(60) + "\n");

  const minerKey = await question("Enter miner key: ");
  
  if (!minerKey || minerKey.trim() === "") {
    console.log("❌ Error: Miner key cannot be empty");
    return;
  }

  const device = await Model.findOne({ miner_key: minerKey.trim() });
  
  if (!device) {
    console.log(`❌ Error: Device '${minerKey}' not found`);
    return;
  }

  if (!device.rewards_exception?.enabled) {
    console.log(`ℹ️  Device '${minerKey}' does not have an active exception`);
    return;
  }

  // Show current exception details
  console.log(`\nCurrent exception details:`);
  console.log(`  Reason: ${device.rewards_exception.reason || "N/A"}`);
  console.log(`  Added by: ${device.rewards_exception.added_by || "N/A"}`);
  console.log(`  Added at: ${device.rewards_exception.added_at?.toISOString() || "N/A"}`);
  if (device.rewards_exception.expires_at) {
    console.log(`  Expires: ${device.rewards_exception.expires_at.toISOString()}`);
  }

  const confirm = await question("\nAre you sure you want to remove this exception? (yes/no): ");
  
  if (confirm.toLowerCase() !== "yes" && confirm.toLowerCase() !== "y") {
    console.log("Operation cancelled.");
    return;
  }

  try {
    const oldReason = device.rewards_exception.reason;
    const oldAddedBy = device.rewards_exception.added_by;
    
    device.rewards_exception = {
      enabled: false,
      reason: undefined,
      added_by: undefined,
      added_at: undefined,
      expires_at: undefined,
    };

    await device.save();

    // Log to audit trail
    logSection(
      `🔐 Hardware Validation Exception REMOVED`,
      `Miner Key: ${minerKey}`,
      `Previous Reason: ${oldReason || "N/A"}`,
      `Previously Added By: ${oldAddedBy || "N/A"}`
    );

    console.log("\n✅ Exception removed successfully!");
  } catch (error) {
    console.log(`❌ Error removing exception: ${error}`);
  }
}

// List all exceptions
async function listExceptions() {
  console.log("\n" + "-".repeat(60));
  console.log("ACTIVE HARDWARE VALIDATION EXCEPTIONS");
  console.log("-".repeat(60) + "\n");

  try {
    const devices = await Model.find({
      "rewards_exception.enabled": true,
    }).select("miner_key name rewards_exception");

    if (devices.length === 0) {
      console.log("ℹ️  No active exceptions found");
      return;
    }

    const now = new Date();
    let activeCount = 0;
    let expiredCount = 0;

    console.log(`Found ${devices.length} device(s) with exceptions:\n`);

    devices.forEach((device, index) => {
      const exc = device.rewards_exception;
      if (!exc) return;

      const isExpired = exc.expires_at && exc.expires_at < now;
      if (isExpired) {
        expiredCount++;
      } else {
        activeCount++;
      }

      console.log(`${index + 1}. ${device.miner_key}${isExpired ? " [EXPIRED]" : ""}`);
      console.log(`   Name: ${device.name || "N/A"}`);
      console.log(`   Reason: ${exc.reason || "N/A"}`);
      console.log(`   Added By: ${exc.added_by || "N/A"}`);
      console.log(`   Added At: ${exc.added_at?.toISOString() || "N/A"}`);
      if (exc.expires_at) {
        console.log(`   Expires: ${exc.expires_at.toISOString()}${isExpired ? " (EXPIRED)" : ""}`);
      } else {
        console.log(`   Expires: Never`);
      }
      console.log("");
    });

    console.log("-".repeat(60));
    console.log(`Summary: ${activeCount} active, ${expiredCount} expired`);
    console.log("-".repeat(60));
  } catch (error) {
    console.log(`❌ Error listing exceptions: ${error}`);
  }
}

// Check device exception status
async function checkDevice() {
  console.log("\n" + "-".repeat(60));
  console.log("CHECK DEVICE EXCEPTION STATUS");
  console.log("-".repeat(60) + "\n");

  const minerKey = await question("Enter miner key: ");
  
  if (!minerKey || minerKey.trim() === "") {
    console.log("❌ Error: Miner key cannot be empty");
    return;
  }

  try {
    const device = await Model.findOne({ miner_key: minerKey.trim() });
    
    if (!device) {
      console.log(`❌ Device '${minerKey}' not found`);
      return;
    }

    console.log(`\nDevice: ${device.miner_key}`);
    console.log(`Name: ${device.name || "N/A"}`);
    
    if (device.rewards_exception?.enabled) {
      const now = new Date();
      const isExpired = device.rewards_exception.expires_at && device.rewards_exception.expires_at < now;
      
      console.log(`\nException Status: ${isExpired ? "⚠️  EXPIRED" : "✅ ACTIVE"}`);
      console.log(`Reason: ${device.rewards_exception.reason || "N/A"}`);
      console.log(`Added By: ${device.rewards_exception.added_by || "N/A"}`);
      console.log(`Added At: ${device.rewards_exception.added_at?.toISOString() || "N/A"}`);
      if (device.rewards_exception.expires_at) {
        console.log(`Expires: ${device.rewards_exception.expires_at.toISOString()}`);
      } else {
        console.log(`Expires: Never`);
      }
    } else {
      console.log(`\nException Status: ❌ NO EXCEPTION`);
    }
  } catch (error) {
    console.log(`❌ Error checking device: ${error}`);
  }
}

// Main menu loop
async function main() {
  try {
    await connect();
    console.log(`\n✅ Connected to ${testMode ? "TEST" : "PRODUCTION"} database`);

    let running = true;

    while (running) {
      displayMenu();
      const choice = await question("\nSelect an option (1-5): ");

      switch (choice.trim()) {
        case "1":
          await addException();
          await question("\nPress Enter to continue...");
          break;
        case "2":
          await removeException();
          await question("\nPress Enter to continue...");
          break;
        case "3":
          await listExceptions();
          await question("\nPress Enter to continue...");
          break;
        case "4":
          await checkDevice();
          await question("\nPress Enter to continue...");
          break;
        case "5":
          running = false;
          console.log("\nGoodbye!");
          break;
        default:
          console.log("\n❌ Invalid option. Please select 1-5.");
          await question("Press Enter to continue...");
      }

      if (running) {
        clearScreen();
      }
    }
  } catch (error) {
    console.error("Fatal error:", error);
  } finally {
    rl.close();
    process.exit(0);
  }
}

// Run the CLI
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
