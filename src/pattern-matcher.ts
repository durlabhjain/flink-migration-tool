// ============================================================================
// Pattern Matcher
// ============================================================================

export class PatternMatcher {
  static matches(value: string, patterns?: string[]): boolean {
    if (!patterns || patterns.length === 0) return true;

    return patterns.some(pattern => {
      // Exact match - if pattern has no wildcards, require exact match
      if (!pattern.includes('*') && !pattern.includes('?')) {
        return value.toLowerCase() === pattern.toLowerCase();
      }

      try {
        // Convert glob pattern to regex
        const regexPattern = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
          .replace(/\*/g, '.*')  // * matches any characters
          .replace(/\?/g, '.');  // ? matches single character

        const regex = new RegExp(`^${regexPattern}$`, 'i');
        return regex.test(value);
      } catch (error) {
        console.warn(`Invalid regex pattern: ${pattern}`);
        return false;
      }
    });
  }

  static shouldInclude(
    value: string,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): boolean {
    // If exclude patterns exist and match, exclude
    if (excludePatterns && excludePatterns.length > 0) {
      if (this.matches(value, excludePatterns)) {
        return false;
      }
    }

    // If include patterns exist, must match at least one
    if (includePatterns && includePatterns.length > 0) {
      return this.matches(value, includePatterns);
    }

    // No include patterns specified, include by default (unless excluded above)
    return true;
  }
}
