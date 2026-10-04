---
name: sql-review
description: Review SQL queries and schema migrations for correctness, locking, performance and data-loss risks. Use when a pull request adds or changes SQL or a migration.
license: MIT
metadata:
  category: database
  tags: sql postgres mysql migration review performance
---

# SQL review

Review database changes the way an experienced DBA would before they reach production.

## Migrations

Check each statement for:

- **Data loss.** `DROP COLUMN`, `DROP TABLE`, narrowing a type or `TRUNCATE` need an explicit
  plan: backup, a deprecation release, or proof the data is unused.
- **Locking.** Adding a column with a volatile default, changing a type, or creating an index
  without `CONCURRENTLY` (Postgres) can lock a large table. Ask how big the table is.
- **Reversibility.** Is there a down migration, or a written rollback plan?
- **Ordering.** Code that reads a new column must ship after the migration; code that stops
  writing a column must ship before the column is dropped.
- **Constraints.** New `NOT NULL` or `UNIQUE` constraints fail on existing bad rows. Look for
  a backfill step first.

## Queries

- Parameters: values must be bound parameters, never string concatenation. Flag any
  interpolation of user input as a SQL injection risk.
- Filtering: every `UPDATE` and `DELETE` has a `WHERE` clause that is clearly correct.
- Indexes: columns used in `WHERE`, `JOIN` and `ORDER BY` on large tables should be indexed.
  Ask for `EXPLAIN` output when in doubt.
- N+1 patterns: queries executed inside loops in application code.
- `SELECT *` in hot paths, unbounded result sets without `LIMIT`, and missing pagination.
- Transactions: multi-statement changes that must succeed together are wrapped in one.

## Output

List findings grouped as **Must fix**, **Should fix** and **Consider**, each with the file,
the statement, the risk and a concrete suggestion. Say clearly when you found nothing serious.
