import { QdrantFilter } from '../qdrant.js';

/**
 * Utility functions for building and validating Qdrant filters
 */

export interface FilterCondition {
  key: string;
  match?: { value: string | number | boolean };
  range?: { 
    gte?: number; 
    lte?: number; 
    gt?: number; 
    lt?: number; 
  };
}

export interface FilterBuilder {
  must?: FilterCondition[];
  should?: FilterCondition[];
  must_not?: FilterCondition[];
}

/**
 * Create a simple match filter
 */
export function createMatchFilter(key: string, value: string | number | boolean): QdrantFilter {
  return {
    must: [
      {
        key,
        match: { value },
      },
    ],
  };
}

/**
 * Create a range filter
 */
export function createRangeFilter(
  key: string,
  options: { gte?: number; lte?: number; gt?: number; lt?: number }
): QdrantFilter {
  return {
    must: [
      {
        key,
        range: options,
      },
    ],
  };
}

/**
 * Create a filter for multiple values (OR condition)
 */
export function createInFilter(key: string, values: (string | number | boolean)[]): QdrantFilter {
  return {
    should: values.map(value => ({
      key,
      match: { value },
    })),
  };
}

/**
 * Create a filter to exclude specific values
 */
export function createNotInFilter(key: string, values: (string | number | boolean)[]): QdrantFilter {
  return {
    must_not: values.map(value => ({
      key,
      match: { value },
    })),
  };
}

/**
 * Combine multiple filters with AND logic
 */
export function combineFiltersAnd(...filters: QdrantFilter[]): QdrantFilter {
  const combined: QdrantFilter = {
    must: [],
    should: [],
    must_not: [],
  };

  for (const filter of filters) {
    if (filter.must) {
      combined.must!.push(...filter.must);
    }
    if (filter.should) {
      // When combining with AND, should conditions become must conditions
      combined.must!.push(...filter.should);
    }
    if (filter.must_not) {
      combined.must_not!.push(...filter.must_not);
    }
  }

  // Clean up empty arrays
  if (combined.must!.length === 0) delete combined.must;
  if (combined.should!.length === 0) delete combined.should;
  if (combined.must_not!.length === 0) delete combined.must_not;

  return combined;
}

/**
 * Combine multiple filters with OR logic
 */
export function combineFiltersOr(...filters: QdrantFilter[]): QdrantFilter {
  // For OR combination, we need to restructure the filters
  const shouldConditions: FilterCondition[] = [];
  const mustNotConditions: FilterCondition[] = [];

  for (const filter of filters) {
    // Convert each filter into a should condition
    if (filter.must && filter.must.length > 0) {
      shouldConditions.push(...filter.must);
    }
    if (filter.should && filter.should.length > 0) {
      shouldConditions.push(...filter.should);
    }
    if (filter.must_not && filter.must_not.length > 0) {
      mustNotConditions.push(...filter.must_not);
    }
  }

  const combined: QdrantFilter = {};
  
  if (shouldConditions.length > 0) {
    combined.should = shouldConditions;
  }
  
  if (mustNotConditions.length > 0) {
    combined.must_not = mustNotConditions;
  }

  return combined;
}

/**
 * Validate a filter structure
 */
export function validateFilter(filter: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!filter || typeof filter !== 'object') {
    errors.push('Filter must be an object');
    return { valid: false, errors };
  }

  const validKeys = ['must', 'should', 'must_not'];
  const filterKeys = Object.keys(filter);
  
  for (const key of filterKeys) {
    if (!validKeys.includes(key)) {
      errors.push(`Invalid filter key: ${key}. Valid keys are: ${validKeys.join(', ')}`);
    }
  }

  // Validate each condition array
  for (const conditionType of ['must', 'should', 'must_not']) {
    const conditions = filter[conditionType];
    if (conditions !== undefined) {
      if (!Array.isArray(conditions)) {
        errors.push(`${conditionType} must be an array`);
        continue;
      }

      for (let i = 0; i < conditions.length; i++) {
        const condition = conditions[i];
        const conditionErrors = validateCondition(condition, `${conditionType}[${i}]`);
        errors.push(...conditionErrors);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a single filter condition
 */
function validateCondition(condition: any, path: string): string[] {
  const errors: string[] = [];

  if (!condition || typeof condition !== 'object') {
    errors.push(`${path}: Condition must be an object`);
    return errors;
  }

  if (!condition.key || typeof condition.key !== 'string') {
    errors.push(`${path}: Condition must have a string 'key' field`);
  }

  const hasMatch = condition.match !== undefined;
  const hasRange = condition.range !== undefined;

  if (!hasMatch && !hasRange) {
    errors.push(`${path}: Condition must have either 'match' or 'range' field`);
  }

  if (hasMatch && hasRange) {
    errors.push(`${path}: Condition cannot have both 'match' and 'range' fields`);
  }

  if (hasMatch) {
    if (!condition.match || typeof condition.match !== 'object') {
      errors.push(`${path}: 'match' must be an object`);
    } else if (condition.match.value === undefined) {
      errors.push(`${path}: 'match' must have a 'value' field`);
    }
  }

  if (hasRange) {
    if (!condition.range || typeof condition.range !== 'object') {
      errors.push(`${path}: 'range' must be an object`);
    } else {
      const range = condition.range;
      const validRangeKeys = ['gte', 'lte', 'gt', 'lt'];
      const rangeKeys = Object.keys(range);
      
      if (rangeKeys.length === 0) {
        errors.push(`${path}: 'range' must have at least one of: ${validRangeKeys.join(', ')}`);
      }

      for (const key of rangeKeys) {
        if (!validRangeKeys.includes(key)) {
          errors.push(`${path}: Invalid range key '${key}'. Valid keys are: ${validRangeKeys.join(', ')}`);
        } else if (typeof range[key] !== 'number') {
          errors.push(`${path}: Range value '${key}' must be a number`);
        }
      }
    }
  }

  return errors;
}

/**
 * Create a filter for documents belonging to a specific docId
 */
export function createDocIdFilter(docId: string): QdrantFilter {
  return createMatchFilter('docId', docId);
}

/**
 * Create a filter for documents with specific metadata
 */
export function createMetadataFilter(metadata: Record<string, string | number | boolean>): QdrantFilter {
  const conditions: FilterCondition[] = [];

  for (const [key, value] of Object.entries(metadata)) {
    conditions.push({
      key,
      match: { value },
    });
  }

  return { must: conditions };
}

/**
 * Create a filter to exclude documents by docId
 */
export function createExcludeDocIdFilter(docIds: string[]): QdrantFilter {
  return createNotInFilter('docId', docIds);
}
