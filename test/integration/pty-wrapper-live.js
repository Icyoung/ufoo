#!/usr/bin/env node
/**
 * PTY Wrapper 实际运行测试
 * 测试真实的PTY进程启动和IO处理
 */

const PtyWrapper = require("../../src/agents/launch/ptyWrapper");
const path = require("path");
const fs = require("fs");

console.log("PTY Wrapper Live Test");
console.log("=====================\n");

// 测试参数
const TEST_LOG = path.join(__dirname, "../../.ufoo/run/test-io.jsonl");
let testsPassed = 0;
let testsFailed = 0;

// 清理旧日志
if (fs.existsSync(TEST_LOG)) {
  fs.unlinkSync(TEST_LOG);
}

// Test 1: 简单命令执行
console.log("Test 1: Simple Command Execution");
console.log("---------------------------------");

const wrapper = new PtyWrapper("echo", ["Hello from PTY"], {
  cwd: process.cwd(),
});

// 启用日志
wrapper.enableLogging(TEST_LOG);

// 收集输出
let output = "";
wrapper.enableMonitoring((data) => {
  output += data;
});

// 设置退出回调
let exitCalled = false;
let exitCode = null;
wrapper.onExit = ({ exitCode: code, signal }) => {
  exitCalled = true;
  exitCode = code;

  console.log("Exit callback received");
  console.log("  Exit code:", code);
  console.log("  Signal:", signal);
  console.log("  Output:", output.trim());

  // 验证结果
  if (output.includes("Hello from PTY")) {
    console.log("✓ Output contains expected text");
    testsPassed++;
  } else {
    console.log("✗ Output missing expected text");
    testsFailed++;
  }

  if (code === 0) {
    console.log("✓ Exit code is 0");
    testsPassed++;
  } else {
    console.log("✗ Exit code is not 0:", code);
    testsFailed++;
  }

  // 验证日志文件
  setTimeout(() => {
    console.log("\nTest 2: Log File Verification");
    console.log("------------------------------");

    if (fs.existsSync(TEST_LOG)) {
      console.log("✓ Log file created");
      testsPassed++;

      const logContent = fs.readFileSync(TEST_LOG, "utf8");
      const lines = logContent.trim().split("\n");

      console.log("  Log entries:", lines.length);

      if (lines.length > 0) {
        console.log("✓ Log file has entries");
        testsPassed++;

        // 验证JSONL格式
        try {
          const firstEntry = JSON.parse(lines[0]);

          if (firstEntry.ts) {
            console.log("✓ Entry has 'ts' field");
            testsPassed++;
          } else {
            console.log("✗ Entry missing 'ts' field");
            testsFailed++;
          }

          if (firstEntry.dir) {
            console.log("✓ Entry has 'dir' field:", firstEntry.dir);
            testsPassed++;
          } else {
            console.log("✗ Entry missing 'dir' field");
            testsFailed++;
          }

          if (firstEntry.data && firstEntry.data.text) {
            console.log("✓ Entry has 'data.text' field");
            testsPassed++;
          } else {
            console.log("✗ Entry missing 'data.text' field");
            testsFailed++;
          }

          if (firstEntry.data && firstEntry.data.encoding) {
            console.log("✓ Entry has 'data.encoding' field:", firstEntry.data.encoding);
            testsPassed++;
          } else {
            console.log("✗ Entry missing 'data.encoding' field");
            testsFailed++;
          }

          if (firstEntry.data && firstEntry.data.size !== undefined) {
            console.log("✓ Entry has 'data.size' field:", firstEntry.data.size);
            testsPassed++;
          } else {
            console.log("✗ Entry missing 'data.size' field");
            testsFailed++;
          }

        } catch (err) {
          console.log("✗ Failed to parse JSONL:", err.message);
          testsFailed++;
        }
      } else {
        console.log("✗ Log file is empty");
        testsFailed++;
      }

      // 显示日志内容示例
      console.log("\n  Log sample (first entry):");
      console.log("  " + lines[0]);

    } else {
      console.log("✗ Log file not created");
      testsFailed++;
    }

    // 清理
    if (fs.existsSync(TEST_LOG)) {
      fs.unlinkSync(TEST_LOG);
    }

    // 总结
    console.log("\n=====================");
    console.log("Test Summary");
    console.log("=====================");
    console.log("Passed:", testsPassed);
    console.log("Failed:", testsFailed);

    if (testsFailed === 0) {
      console.log("\n✓ All tests passed!");
      process.exit(0);
    } else {
      console.log("\n✗ Some tests failed");
      process.exit(1);
    }
  }, 100);
};

// 启动PTY
console.log("Spawning PTY with command: echo 'Hello from PTY'");
try {
  wrapper.spawn();

  // 模拟streams（使用process的streams但不真正attach，只触发内部逻辑）
  // 这里我们只测试PTY本身的功能
  console.log("✓ PTY spawned successfully");
  testsPassed++;

} catch (err) {
  console.log("✗ Failed to spawn PTY:", err.message);
  testsFailed++;
  process.exit(1);
}
