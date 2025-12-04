// ============================================================================
// SQL Formula Converter Utilities
// ============================================================================
// Helper functions to convert MSSQL computed column formulas to MySQL/StarRocks syntax

import { ColumnInfo } from './types';

/**
 * Fix column name casing in formulas to match actual column names
 * StarRocks is case-sensitive, but MSSQL formulas may have inconsistent casing
 */
export function fixColumnNameCasing(formula: string, columns: ColumnInfo[]): string {
  let result = formula;

  // For each column, find references to it (with backticks) and fix the casing
  for (const col of columns) {
    // Match `columnname` in any case and replace with correct case
    const regex = new RegExp(`\`${col.name}\``, 'gi');
    result = result.replace(regex, `\`${col.name}\``);
  }

  return result;
}

/**
 * Convert + operators to CONCAT() for string concatenation
 * This properly handles nested expressions and avoids breaking CASE statements
 */
export function convertPlusToConcat(str: string): string {
  let result = str;
  let changed = true;
  let iterations = 0;

  while (changed && iterations < 25) {
    const before = result;

    // First, simplify parentheses around simple expressions
    // (CONCAT(...)) + expr -> CONCAT(...) + expr
    result = result.replace(/\((CONCAT\([^)]+\))\)\s*\+/g, '$1+');
    result = result.replace(/\+\s*\((CONCAT\([^)]+\))\)/g, '+$1');

    // Pattern 1: literal + column or column + literal
    result = result.replace(
      /'([^']+)'\s*\+\s*`([^`]+)`/g,
      (_match, lit, col) => `CONCAT('${lit}', \`${col}\`)`
    );
    result = result.replace(
      /`([^`]+)`\s*\+\s*'([^']+)'/g,
      (_match, col, lit) => `CONCAT(\`${col}\`, '${lit}')`
    );

    // Pattern 2: column + column
    result = result.replace(
      /`([^`]+)`\s*\+\s*`([^`]+)`/g,
      (_match, col1, col2) => `CONCAT(\`${col1}\`, \`${col2}\`)`
    );

    // Pattern 3: CONCAT(...) + literal or column (but not inside CASE)
    // Use negative lookahead to avoid matching inside CASE WHEN...THEN
    result = result.replace(
      /CONCAT\(([^)]+(?:\([^)]*\))?[^)]*)\)\s*\+\s*('([^']+)'|`([^`]+)`)/g,
      (_match, args, token) => `CONCAT(${args}, ${token})`
    );

    // Pattern 4: literal/column + CONCAT(...)
    result = result.replace(
      /('([^']+)'|`([^`]+)`)\s*\+\s*CONCAT\(([^)]+(?:\([^)]*\))?[^)]*)\)/g,
      (_match, token, _lit, _col, args) => `CONCAT(${token}, ${args})`
    );

    // Pattern 5: CONCAT(...) + CAST(...)
    result = result.replace(
      /CONCAT\(([^)]+(?:\([^)]*\))?[^)]*)\)\s*\+\s*CAST\(([^)]+)\s+AS\s+([^)]+)\)/gi,
      (_match, concatArgs, castExpr, castType) => `CONCAT(${concatArgs}, CAST(${castExpr} AS ${castType}))`
    );

    // Pattern 6: CAST(...) + CONCAT(...)
    result = result.replace(
      /CAST\(([^)]+)\s+AS\s+([^)]+)\)\s*\+\s*CONCAT\(([^)]+(?:\([^)]*\))?[^)]*)\)/gi,
      (_match, castExpr, castType, concatArgs) => `CONCAT(CAST(${castExpr} AS ${castType}), ${concatArgs})`
    );

    // Pattern 7: literal + CAST(...)
    result = result.replace(
      /'([^']+)'\s*\+\s*CAST\(([^)]+)\s+AS\s+([^)]+)\)/gi,
      (_match, lit, castExpr, castType) => `CONCAT('${lit}', CAST(${castExpr} AS ${castType}))`
    );

    // Pattern 8: CAST(...) + literal
    result = result.replace(
      /CAST\(([^)]+)\s+AS\s+([^)]+)\)\s*\+\s*'([^']+)'/gi,
      (_match, castExpr, castType, lit) => `CONCAT(CAST(${castExpr} AS ${castType}), '${lit}')`
    );

    // Pattern 9: CAST(...) + column
    result = result.replace(
      /CAST\(([^)]+)\s+AS\s+([^)]+)\)\s*\+\s*`([^`]+)`/gi,
      (_match, castExpr, castType, col) => `CONCAT(CAST(${castExpr} AS ${castType}), \`${col}\`)`
    );

    // Pattern 10: column + CAST(...)
    result = result.replace(
      /`([^`]+)`\s*\+\s*CAST\(([^)]+)\s+AS\s+([^)]+)\)/gi,
      (_match, col, castExpr, castType) => `CONCAT(\`${col}\`, CAST(${castExpr} AS ${castType}))`
    );

    // Pattern 11: coalesce(...) + literal or column
    result = result.replace(
      /coalesce\(([^)]+(?:\([^)]*\))?[^)]*)\)\s*\+\s*('([^']+)'|`([^`]+)`)/gi,
      (_match, args, token) => `CONCAT(coalesce(${args}), ${token})`
    );

    // Pattern 12: literal or column + coalesce(...)
    result = result.replace(
      /('([^']+)'|`([^`]+)`)\s*\+\s*coalesce\(([^)]+(?:\([^)]*\))?[^)]*)\)/gi,
      (_match, token, _lit, _col, args) => `CONCAT(${token}, coalesce(${args}))`
    );

    // Pattern 13: IFNULL(...) + literal or column
    result = result.replace(
      /IFNULL\(([^)]+(?:\([^)]*\))?[^)]*)\)\s*\+\s*('([^']+)'|`([^`]+)`)/gi,
      (_match, args, token) => `CONCAT(IFNULL(${args}), ${token})`
    );

    // Pattern 14: literal or column + IFNULL(...)
    result = result.replace(
      /('([^']+)'|`([^`]+)`)\s*\+\s*IFNULL\(([^)]+(?:\([^)]*\))?[^)]*)\)/gi,
      (_match, token, _lit, _col, args) => `CONCAT(${token}, IFNULL(${args}))`
    );

    changed = (before !== result);
    iterations++;
  }

  // Final cleanup: Remove excessive parentheses
  result = result.replace(/^\({3,}(CONCAT\(.+\))\){3,}$/g, '(($1))');
  result = result.replace(/\){4,}/g, ')))');

  return result;
}

/**
 * Helper function to match and extract content within balanced parentheses
 * startIdx should point to the position RIGHT AFTER the opening parenthesis
 */
export function findMatchingParen(str: string, startIdx: number): number {
  let depth = 1;  // We've already passed one opening parenthesis
  for (let i = startIdx; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Replace DATEADD with proper handling of nested parentheses
 */
export function replaceDateAdd(str: string): string {
  const regex = /\bdateadd\s*\(/gi;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(str)) !== null) {
    const startIdx = match.index + match[0].length;
    const endIdx = findMatchingParen(str, startIdx);

    if (endIdx !== -1) {
      const args = str.substring(startIdx, endIdx);
      const parts = splitByComma(args);

      if (parts.length === 3) {
        const unit = parts[0].trim().toUpperCase();
        let value = parts[1].trim();
        const date = parts[2].trim();

        // Remove outer parentheses from value if present (e.g., "(-30)" -> "-30")
        value = value.replace(/^\(([^()]+)\)$/, '$1');

        result += str.substring(lastIndex, match.index);
        result += `DATE_ADD(${date}, INTERVAL ${value} ${unit})`;
        lastIndex = endIdx + 1;
      }
    }
  }

  result += str.substring(lastIndex);
  return result;
}

/**
 * Replace DATEDIFF with proper handling of nested parentheses
 */
export function replaceDateDiff(str: string): string {
  const regex = /\bdatediff\s*\(/gi;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(str)) !== null) {
    const startIdx = match.index + match[0].length;
    const endIdx = findMatchingParen(str, startIdx);

    if (endIdx !== -1) {
      const args = str.substring(startIdx, endIdx);
      const parts = splitByComma(args);

      if (parts.length === 3) {
        const unit = parts[0].trim().toUpperCase();
        const start = parts[1].trim();
        const end = parts[2].trim();

        result += str.substring(lastIndex, match.index);
        result += `TIMESTAMPDIFF(${unit}, ${start}, ${end})`;
        lastIndex = endIdx + 1;
      }
    }
  }

  result += str.substring(lastIndex);
  return result;
}

/**
 * Replace CONVERT with proper handling of nested parentheses
 */
export function replaceConvert(str: string): string {
  const regex = /\bconvert\s*\(/gi;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(str)) !== null) {
    const startIdx = match.index + match[0].length;
    const endIdx = findMatchingParen(str, startIdx);

    if (endIdx !== -1) {
      const args = str.substring(startIdx, endIdx);
      const parts = splitByComma(args);

      if (parts.length >= 2) {
        const typeStr = parts[0].trim().replace(/`/g, '');
        const value = parts[1].trim();

        // Parse type (e.g., "varchar(10)" or "decimal(18,2)")
        const typeMatch = typeStr.match(/^(\w+)(?:\(([^)]+)\))?/);
        if (typeMatch) {
          const lowerType = typeMatch[1].toLowerCase();
          const typeParams = typeMatch[2];
          let mysqlType = lowerType;

          if (lowerType === 'varchar') {
            mysqlType = typeParams ? `CHAR(${typeParams})` : 'CHAR';
          } else if (lowerType === 'bit') {
            mysqlType = 'TINYINT';
          } else if (lowerType === 'decimal' || lowerType === 'numeric') {
            mysqlType = typeParams ? `DECIMAL(${typeParams})` : 'DECIMAL';
          } else if (lowerType === 'date') {
            mysqlType = 'DATE';
          } else if (lowerType === 'datetime') {
            mysqlType = 'DATETIME';
          } else if (lowerType === 'int') {
            mysqlType = 'SIGNED';
          } else if (lowerType === 'bigint') {
            mysqlType = 'SIGNED';
          } else if (lowerType === 'varbinary') {
            mysqlType = 'BINARY';
          }

          result += str.substring(lastIndex, match.index);
          result += `CAST(${value} AS ${mysqlType})`;
          lastIndex = endIdx + 1;
        }
      }
    }
  }

  result += str.substring(lastIndex);
  return result;
}

/**
 * Split string by comma, but respect nested parentheses
 */
export function splitByComma(str: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '(') {
      depth++;
      current += char;
    } else if (char === ')') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

/**
 * Converts MSSQL computed column formula to MySQL/StarRocks compatible syntax
 */
export function convertMSSQLFormulaToMySQL(formula: string): string {
  if (!formula) return '';

  let converted = formula;

  // STEP 1: Remove MSSQL brackets around column names: [ColumnName] -> `ColumnName`
  converted = converted.replace(/\[([^\]]+)\]/g, '`$1`');

  // STEP 2: Convert simple date/time functions FIRST (before complex ones)
  converted = converted.replace(/\bgetdate\s*\(\s*\)/gi, 'NOW()');
  converted = converted.replace(/\bgetutcdate\s*\(\s*\)/gi, 'UTC_TIMESTAMP()');

  // STEP 3 & 4: Convert DATEADD and DATEDIFF with proper parentheses matching
  let prevDateConverted = '';
  let dateIterations = 0;
  const maxDateIterations = 5;

  while (prevDateConverted !== converted && dateIterations < maxDateIterations) {
    prevDateConverted = converted;
    converted = replaceDateAdd(converted);
    converted = replaceDateDiff(converted);
    dateIterations++;
  }

  // STEP 5: Convert DATEPART function
  // DATEPART(weekday, date) -> DAYOFWEEK(date)
  // DATEPART(year, date) -> YEAR(date)
  // DATEPART(month, date) -> MONTH(date)
  // DATEPART(day, date) -> DAY(date)
  // DATEPART(hour, date) -> HOUR(date)
  // DATEPART(minute, date) -> MINUTE(date)
  // DATEPART(second, date) -> SECOND(date)
  converted = converted.replace(
    /\bdatepart\s*\(\s*weekday\s*,\s*([^)]+)\)/gi,
    (_match, date) => `DAYOFWEEK(${date.trim()})`
  );
  converted = converted.replace(
    /\bdatepart\s*\(\s*year\s*,\s*([^)]+)\)/gi,
    (_match, date) => `YEAR(${date.trim()})`
  );
  converted = converted.replace(
    /\bdatepart\s*\(\s*month\s*,\s*([^)]+)\)/gi,
    (_match, date) => `MONTH(${date.trim()})`
  );
  converted = converted.replace(
    /\bdatepart\s*\(\s*day\s*,\s*([^)]+)\)/gi,
    (_match, date) => `DAY(${date.trim()})`
  );
  converted = converted.replace(
    /\bdatepart\s*\(\s*hour\s*,\s*([^)]+)\)/gi,
    (_match, date) => `HOUR(${date.trim()})`
  );
  converted = converted.replace(
    /\bdatepart\s*\(\s*minute\s*,\s*([^)]+)\)/gi,
    (_match, date) => `MINUTE(${date.trim()})`
  );
  converted = converted.replace(
    /\bdatepart\s*\(\s*second\s*,\s*([^)]+)\)/gi,
    (_match, date) => `SECOND(${date.trim()})`
  );

  // STEP 6: Convert other NULL and string functions
  converted = converted.replace(/\bisnull\s*\(/gi, 'IFNULL(');
  converted = converted.replace(/\blen\s*\(/gi, 'CHAR_LENGTH(');
  converted = converted.replace(/\brtrim\s*\(/gi, 'TRIM(');
  converted = converted.replace(/\bltrim\s*\(/gi, 'TRIM(');

  // ISJSON() - StarRocks doesn't have a direct equivalent
  converted = converted.replace(/\bisjson\s*\(([^)]+)\)/gi, (_match, arg) => {
    return `IF(${arg.trim()} REGEXP '^[\\\\{\\\\[]', 1, 0)`;
  });

  // STEP 6: Convert CONVERT for type conversions
  converted = replaceConvert(converted);

  // STEP 7: Convert CHECKSUM()
  converted = converted.replace(
    /\bchecksum\s*\(([^)]+)\)/gi,
    (_match, args) => {
      return `CRC32(CONCAT_WS(',', ${args}))`;
    }
  );

  // STEP 7.5: Convert hierarchyid methods
  // hierarchyid.GetLevel() -> returns the level in the hierarchy (StarRocks doesn't support hierarchyid)
  // Match both `column`.`GetLevel`() and `column`.GetLevel() patterns
  converted = converted.replace(
    /`([^`]+)`\.`?GetLevel`?\s*\(\s*\)/gi,
    (_match, columnName) => {
      // GetLevel() returns the depth level of the hierarchyid
      // Since StarRocks doesn't have hierarchyid, assume it's stored as STRING with path like '/1/2/3/'
      // Count the slashes to determine level (subtract 1 because path starts and ends with /)
      return `(CHAR_LENGTH(\`${columnName}\`) - CHAR_LENGTH(REPLACE(\`${columnName}\`, '/', '')) - 1)`;
    }
  );

  // Handle hierarchyid.ToString() - converts hierarchyid to string representation
  converted = converted.replace(
    /`([^`]+)`\.`?ToString`?\s*\(\s*\)/gi,
    (_match, columnName) => {
      // If already stored as string, just return the column
      return `\`${columnName}\``;
    }
  );

  // STEP 8: Convert string concatenation + to CONCAT()
  converted = convertPlusToConcat(converted);

  // Warn about user-defined functions
  if (converted.match(/`dbo`\.`\w+`\s*\(/i)) {
    console.warn('Warning: User-defined functions detected in computed columns. Manual review may be required.');
  }

  return converted;
}

/**
 * Infer the StarRocks data type for a computed column based on its formula and original MSSQL type
 */
export function inferComputedColumnType(col: ColumnInfo, formula: string): string {
  const lowerFormula = formula.toLowerCase();

  // Check for CASE expressions - the result type is determined by THEN/ELSE values
  if (lowerFormula.includes('case when')) {
    const thenMatches = formula.match(/then\s*\(?\s*([01])\s*\)?/gi);
    const elseMatches = formula.match(/else\s*\(?\s*([01])\s*\)?/gi);

    if (thenMatches && elseMatches) {
      return 'TINYINT';
    }
  }

  // Check for hierarchyid.GetLevel() - returns SMALLINT
  if (lowerFormula.includes('char_length') && lowerFormula.includes('replace') && lowerFormula.includes("'/'")) {
    return 'SMALLINT';
  }

  // Check for TIMESTAMPDIFF outside of CASE expressions
  if (lowerFormula.includes('timestampdiff') || lowerFormula.includes('datediff')) {
    return 'BIGINT';
  }

  // Try to infer from the MSSQL type if available
  if (col.sqlServerType) {
    const lowerType = col.sqlServerType.toLowerCase();

    if (lowerType.includes('bit')) return 'BOOLEAN';
    if (lowerType.includes('tinyint')) return 'TINYINT';
    if (lowerType.includes('smallint')) return 'SMALLINT';
    if (lowerType.includes('int')) return 'INT';
    if (lowerType.includes('bigint')) return 'BIGINT';
    if (lowerType.includes('decimal') || lowerType.includes('numeric')) {
      if (col.precision && col.scale !== undefined) {
        return `DECIMAL(${col.precision},${col.scale})`;
      }
      return 'DECIMAL(18,2)';
    }
    if (lowerType.includes('float')) return 'DOUBLE';
    if (lowerType.includes('real')) return 'FLOAT';
    if (lowerType.includes('date') && !lowerType.includes('time')) return 'DATE';
    if (lowerType.includes('datetime') || lowerType.includes('datetime2')) return 'DATETIME';
    if (lowerType.includes('varchar') || lowerType.includes('nvarchar')) {
      if (col.maxLength && col.maxLength > 0 && col.maxLength < 65535) {
        return `VARCHAR(${col.maxLength})`;
      }
      return 'VARCHAR(65535)';
    }
    if (lowerType.includes('char')) return 'VARCHAR(255)';
    if (lowerType.includes('text')) return 'VARCHAR(65535)';
  }

  // Infer from formula pattern
  if (lowerFormula.includes('timestampdiff') || lowerFormula.includes('datediff')) {
    return 'BIGINT';
  }
  if (lowerFormula.includes('date_add') || lowerFormula.includes('dateadd')) {
    return 'DATETIME';
  }
  if (lowerFormula.includes('now()') || lowerFormula.includes('utc_timestamp()')) {
    return 'DATETIME';
  }
  if (lowerFormula.includes('cast') && lowerFormula.includes('as date')) {
    return 'DATE';
  }
  if (lowerFormula.includes('cast') && lowerFormula.includes('as datetime')) {
    return 'DATETIME';
  }

  // Check for string functions
  if (lowerFormula.includes('concat') || lowerFormula.includes('trim') ||
      lowerFormula.includes('replace') || lowerFormula.includes('substring')) {
    return 'VARCHAR(65535)';
  }

  // Check for numeric operations
  if (lowerFormula.includes('cast') && lowerFormula.includes('as decimal')) {
    const match = lowerFormula.match(/decimal\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (match) {
      return `DECIMAL(${match[1]},${match[2]})`;
    }
    return 'DECIMAL(18,2)';
  }
  if (lowerFormula.includes('cast') && lowerFormula.includes('as signed')) {
    return 'BIGINT';
  }
  if (lowerFormula.includes('cast') && lowerFormula.includes('as unsigned')) {
    return 'BIGINT';
  }

  // Check for CASE expressions returning different types
  if (lowerFormula.includes('case when')) {
    if (lowerFormula.match(/then\s*\(?\s*[01]\s*\)?/)) {
      return 'TINYINT';
    }
    if (lowerFormula.match(/then\s*\(?\s*-?\d+\s*\)?/)) {
      return 'INT';
    }
    if (lowerFormula.match(/then\s*['"`]/)) {
      return 'VARCHAR(255)';
    }
  }

  // Check for CRC32, checksum functions
  if (lowerFormula.includes('crc32')) {
    return 'BIGINT';
  }

  // Check for IF function with REGEXP
  if (lowerFormula.includes('if(') && lowerFormula.includes('regexp')) {
    return 'TINYINT';
  }

  // Default fallback
  if (lowerFormula.match(/^\s*\(?\s*\d+\s*\)?/)) {
    return 'INT';
  }

  return 'VARCHAR(255)';
}
