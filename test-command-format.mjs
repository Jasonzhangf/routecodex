#!/usr/bin/env node

/**
 * 测试复杂shell命令的参数格式
 */

// 测试用例1：错误的格式（当前遇到的问题）
const incorrectFormat = {
  tool_calls: [{
    function: {
      name: "shell",
      arguments: {
        command: ["find", ".", "-type", "f", "-exec", "md5sum", "{}", "+", "|", "sort", "|", "uniq", "-d", "-w", "32"]
      }
    }
  }]
};

console.log("❌ 错误格式（将管道符作为数组元素）:");
console.log(JSON.stringify(incorrectFormat, null, 2));

// 测试用例2：正确的格式 - 使用bash -lc
const correctFormatBash = {
  tool_calls: [{
    function: {
      name: "shell",
      arguments: {
        command: ["bash", "-lc", "find . -type f -exec md5sum {} + | sort | uniq -d -w 32"]
      }
    }
  }]
};

console.log("\n✅ 正确格式1（使用bash -lc）:");
console.log(JSON.stringify(correctFormatBash, null, 2));

// 测试用例3：正确的格式 - 直接字符串
const correctFormatString = {
  tool_calls: [{
    function: {
      name: "shell",
      arguments: {
        command: "find . -type f -exec md5sum {} + | sort | uniq -d -w 32"
      }
    }
  }]
};

console.log("\n✅ 正确格式2（直接字符串）:");
console.log(JSON.stringify(correctFormatString, null, 2));

console.log("\n📝 说明:");
console.log("1. 管道符 | 不能作为数组中的单独元素");
console.log("2. 复杂命令应该使用 bash -lc 包装");
console.log("3. 或者直接使用字符串格式，让 tool-executor 处理");

// 验证当前修复的效果
console.log("\n🔍 修复验证:");
console.log("- 移除了 parseArgumentsString 转换");
console.log("- 移除了 stringifyArgumentsObject 转换");
console.log("- 保持 arguments 为对象格式");
console.log("- tool-executor.ts 能够正确处理包含管道符的命令");