import { getSimNow } from '../time-control';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitized?: any;
}

export class InputValidator {
  // MongoDB injection patterns
  private static readonly MONGO_INJECTION_PATTERNS = [
    /\$where/i,
    /\$ne/i,
    /\$in/i,
    /\$nin/i,
    /\$gt/i,
    /\$gte/i,
    /\$lt/i,
    /\$lte/i,
    /\$or/i,
    /\$and/i,
    /\$not/i,
    /\$nor/i,
    /\$exists/i,
    /\$type/i,
    /\$mod/i,
    /\$regex/i,
    /\$options/i
  ];

  // SQL injection patterns (just in case)
  private static readonly SQL_INJECTION_PATTERNS = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b)/i,
    /(\b(OR|AND)\b.*?['"]\s*['"]\s*['"]\s*['"])/i,
    /(--|\#|\/\*|\*\/)/,
    /('|(\\')|(;))/
  ];

  // XSS patterns
  private static readonly XSS_PATTERNS = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
    /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
    /<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi,
    /javascript:/i,
    /on\w+\s*=/i,
    /<img[^>]*src\s*=\s*['"]\s*javascript:/i
  ];

  // Validate miner key format
  public static validateMinerKey(minerKey: any): ValidationResult {
    const errors: string[] = [];
    
    if (typeof minerKey !== 'string') {
      errors.push('Miner key must be a string');
      return { valid: false, errors };
    }

    if (!minerKey || minerKey.trim().length === 0) {
      errors.push('Miner key cannot be empty');
      return { valid: false, errors };
    }

    const sanitized = minerKey.trim().toUpperCase();
    
    // Check format: MINER-XXXXX or similar patterns
    if (!/^[A-Z]{2,10}-[A-Z0-9]{5,20}$/i.test(sanitized)) {
      errors.push('Invalid miner key format (expected: ABC-123456)');
    }

    if (sanitized.length > 50) {
      errors.push('Miner key too long (max 50 characters)');
    }

    // Check for injection patterns
    if (this.containsMaliciousPatterns(sanitized)) {
      errors.push('Miner key contains invalid characters');
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: errors.length === 0 ? sanitized : undefined
    };
  }

  // Validate wallet address
  public static validateWalletAddress(address: any): ValidationResult {
    const errors: string[] = [];
    
    if (typeof address !== 'string') {
      errors.push('Wallet address must be a string');
      return { valid: false, errors };
    }

    if (!address || address.trim().length === 0) {
      errors.push('Wallet address cannot be empty');
      return { valid: false, errors };
    }

    const sanitized = address.trim();
    
    // Algorand address validation (58 characters, base32)
    if (!/^[A-Z2-7]{58}$/.test(sanitized)) {
      errors.push('Invalid Algorand wallet address format');
    }

    // Check for injection patterns
    if (this.containsMaliciousPatterns(sanitized)) {
      errors.push('Wallet address contains invalid characters');
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: errors.length === 0 ? sanitized : undefined
    };
  }

  // Validate asset ID
  public static validateAssetId(assetId: any): ValidationResult {
    const errors: string[] = [];
    
    if (typeof assetId !== 'string' && typeof assetId !== 'number') {
      errors.push('Asset ID must be a string or number');
      return { valid: false, errors };
    }

    const sanitized = String(assetId).trim();
    
    if (!sanitized || sanitized.length === 0) {
      errors.push('Asset ID cannot be empty');
      return { valid: false, errors };
    }

    // Algorand asset IDs are numeric
    if (!/^\d+$/.test(sanitized)) {
      errors.push('Asset ID must be numeric');
    }

    const numericValue = parseInt(sanitized, 10);
    if (numericValue < 0 || numericValue > Number.MAX_SAFE_INTEGER) {
      errors.push('Asset ID out of valid range');
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: errors.length === 0 ? sanitized : undefined
    };
  }

  // Validate reward amount
  public static validateRewardAmount(amount: any): ValidationResult {
    const errors: string[] = [];
    
    if (typeof amount !== 'number' && typeof amount !== 'string') {
      errors.push('Reward amount must be a number or string');
      return { valid: false, errors };
    }

    const numericAmount = typeof amount === 'number' ? amount : parseFloat(String(amount));
    
    if (isNaN(numericAmount)) {
      errors.push('Reward amount must be a valid number');
      return { valid: false, errors };
    }

    if (numericAmount < 0) {
      errors.push('Reward amount cannot be negative');
    }

    if (numericAmount > 1000000) {
      errors.push('Reward amount too large (max: 1,000,000)');
    }

    // Check for reasonable decimal places (max 6)
    const decimalPlaces = (String(numericAmount).split('.')[1] || '').length;
    if (decimalPlaces > 6) {
      errors.push('Reward amount has too many decimal places (max: 6)');
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: errors.length === 0 ? Math.round(numericAmount * 1000000) / 1000000 : undefined
    };
  }

  // Validate date string
  public static validateDateString(dateStr: any): ValidationResult {
    const errors: string[] = [];
    
    if (typeof dateStr !== 'string') {
      errors.push('Date must be a string');
      return { valid: false, errors };
    }

    if (!dateStr || dateStr.trim().length === 0) {
      errors.push('Date cannot be empty');
      return { valid: false, errors };
    }

    const sanitized = dateStr.trim();
    
    // Check ISO format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss.sssZ)
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/.test(sanitized)) {
      errors.push('Invalid date format (expected ISO 8601)');
      return { valid: false, errors };
    }

    const date = new Date(sanitized);
    if (isNaN(date.getTime())) {
      errors.push('Invalid date value');
      return { valid: false, errors };
    }

    // Check reasonable date range (not too far in past/future)
    const now = getSimNow();
    const minDate = new Date('2020-01-01');
    const maxDate = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000); // 10 years future
    
    if (date < minDate || date > maxDate) {
      errors.push('Date outside valid range (2020 - 10 years from now)');
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: errors.length === 0 ? date.toISOString() : undefined
    };
  }

  // Validate pagination parameters
  public static validatePagination(page: any, limit: any): ValidationResult {
    const errors: string[] = [];
    
    const pageNum = parseInt(String(page || '1'), 10);
    const limitNum = parseInt(String(limit || '20'), 10);
    
    if (isNaN(pageNum) || pageNum < 1) {
      errors.push('Page must be a positive integer');
    }

    if (pageNum > 10000) {
      errors.push('Page number too large (max: 10,000)');
    }

    if (isNaN(limitNum) || limitNum < 1) {
      errors.push('Limit must be a positive integer');
    }

    if (limitNum > 1000) {
      errors.push('Limit too large (max: 1,000)');
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: errors.length === 0 ? { page: pageNum, limit: limitNum } : undefined
    };
  }

  // Validate admin token
  public static validateAdminToken(token: any): ValidationResult {
    const errors: string[] = [];
    
    if (typeof token !== 'string') {
      errors.push('Token must be a string');
      return { valid: false, errors };
    }

    if (!token || token.trim().length === 0) {
      errors.push('Token cannot be empty');
      return { valid: false, errors };
    }

    const sanitized = token.trim();
    
    // Check token format (hex string, min 32 chars)
    if (!/^[a-fA-F0-9]{32,}$/.test(sanitized)) {
      errors.push('Invalid token format');
    }

    if (sanitized.length < 32 || sanitized.length > 128) {
      errors.push('Token length invalid (32-128 characters)');
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: errors.length === 0 ? sanitized : undefined
    };
  }

  // Check for malicious patterns
  private static containsMaliciousPatterns(input: string): boolean {
    const patterns = [
      ...this.MONGO_INJECTION_PATTERNS,
      ...this.SQL_INJECTION_PATTERNS,
      ...this.XSS_PATTERNS
    ];

    return patterns.some(pattern => pattern.test(input));
  }

  // Sanitize general text input
  public static sanitizeText(input: any, maxLength: number = 1000): ValidationResult {
    const errors: string[] = [];
    
    if (typeof input !== 'string') {
      errors.push('Input must be a string');
      return { valid: false, errors };
    }

    let sanitized = input.trim();
    
    if (sanitized.length > maxLength) {
      errors.push(`Input too long (max: ${maxLength} characters)`);
    }

    // Remove potential XSS
    sanitized = sanitized
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '');

    // Check for injection patterns
    if (this.containsMaliciousPatterns(sanitized)) {
      errors.push('Input contains potentially malicious content');
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: errors.length === 0 ? sanitized : undefined
    };
  }

  // Validate bulk input (arrays)
  public static validateBulkInput<T>(
    items: any,
    validator: (item: any) => ValidationResult,
    maxItems: number = 1000
  ): ValidationResult {
    const errors: string[] = [];
    
    if (!Array.isArray(items)) {
      errors.push('Input must be an array');
      return { valid: false, errors };
    }

    if (items.length === 0) {
      errors.push('Array cannot be empty');
      return { valid: false, errors };
    }

    if (items.length > maxItems) {
      errors.push(`Too many items (max: ${maxItems})`);
      return { valid: false, errors };
    }

    const sanitizedItems: T[] = [];
    const itemErrors: string[] = [];

    items.forEach((item, index) => {
      const result = validator(item);
      if (!result.valid) {
        itemErrors.push(`Item ${index}: ${result.errors.join(', ')}`);
      } else {
        sanitizedItems.push(result.sanitized);
      }
    });

    if (itemErrors.length > 0) {
      errors.push(...itemErrors);
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: errors.length === 0 ? sanitizedItems : undefined
    };
  }

  // Validate IP address
  public static validateIPAddress(ip: any): ValidationResult {
    const errors: string[] = [];
    
    if (typeof ip !== 'string') {
      errors.push('IP address must be a string');
      return { valid: false, errors };
    }

    const sanitized = ip.trim();
    
    // IPv4 validation
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    
    // IPv6 validation (simplified)
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    
    if (!ipv4Regex.test(sanitized) && !ipv6Regex.test(sanitized) && sanitized !== 'unknown') {
      errors.push('Invalid IP address format');
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: errors.length === 0 ? sanitized : undefined
    };
  }
}

// Express middleware for input validation
export function createValidationMiddleware(validators: { [key: string]: (value: any) => ValidationResult }) {
  return (req: any, res: any, next: any) => {
    const errors: string[] = [];
    const sanitized: any = {};
    
    // Validate request body
    if (req.body) {
      for (const [field, validator] of Object.entries(validators)) {
        if (req.body.hasOwnProperty(field)) {
          const result = validator(req.body[field]);
          if (!result.valid) {
            errors.push(`${field}: ${result.errors.join(', ')}`);
          } else {
            sanitized[field] = result.sanitized;
          }
        }
      }
    }
    
    // Validate query parameters
    if (req.query) {
      for (const [field, validator] of Object.entries(validators)) {
        if (req.query.hasOwnProperty(field)) {
          const result = validator(req.query[field]);
          if (!result.valid) {
            errors.push(`${field}: ${result.errors.join(', ')}`);
          } else {
            sanitized[field] = result.sanitized;
          }
        }
      }
    }
    
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors
      });
    }
    
    // Attach sanitized data to request
    req.validated = sanitized;
    next();
  };
}
