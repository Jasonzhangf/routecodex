  private determineStopSequence(message: StandardizedMessage): string | undefined {
    // 检查是否包含特定的停止序列
    const stopSequences = ['\n\nHuman:', '\n\nUSER:', '\n\nAssistant:', ''];

    if (message.content) {
      for (const sequence of stopSequences) {
        if (message.content.includes(sequence)) {
          return sequence;
        }
      }
    }

    return undefined;
  }