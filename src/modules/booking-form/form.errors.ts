import { HttpStatus } from '@nestjs/common';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import type { ValidationIssue } from './form.logic.js';

/**
 * 400 VALIDATION_ERROR carrying every issue at once: `details.fields` keeps
 * the M1 shape (path -> messages) and `details.issues` adds codes and meta,
 * so clients can map server errors to form fields.
 */
export function issuesError(issues: ValidationIssue[], message?: string): AppException {
  const fields: Record<string, string[]> = {};
  for (const i of issues) (fields[i.path] ??= []).push(i.message);
  const text = message ?? (issues.length === 1 ? issues[0]!.message : 'Please check the highlighted fields');
  return new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, text, { fields, issues });
}

export function throwIfIssues(issues: ValidationIssue[], message?: string): void {
  if (issues.length) throw issuesError(issues, message);
}
