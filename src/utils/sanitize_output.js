function sanitizeAIOutput(text) {
    if (!text) return text;

    return text
        // 1. Remove full blocks with contents
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        // 2. Remove any remaining stray tags or malformed variations
        .replace(/<\/?\s*think\s*>/gi, "")
        .replace(/<\s*thought\s*>[\s\S]*?<\/\s*thought\s*>/gi, "")
        // 3. Remove raw markers if the AI leaked them as text (e.g. "think: ...") at start of output or after newlines
        .replace(/(?:^|[\r\n]+)\s*think[:\s-]*/gi, "")
        .replace(/(?:^|[\r\n]+)\s*thought[:\s-]*/gi, "")
        .trim();
}

module.exports = { sanitizeAIOutput };
