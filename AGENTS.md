# Repository Guidelines

## Project Structure & Data Organization

This repository is a data-only archive. The root currently contains `DİPLOMA KAYIT BİLGİLER 1974-1997.xls`, a legacy Excel workbook holding the project data. There are no source, test, build, or asset directories. Keep the original workbook at the repository root unless a migration is explicitly approved. Put any future documentation beside this guide; place generated exports in a clearly named directory such as `exports/` and do not commit temporary lock files (`~$*.xls`).

## Validation & Local Commands

There is no automated build or test suite. Use these PowerShell checks before submitting changes:

```powershell
Get-ChildItem -Force
Get-FileHash '.\DİPLOMA KAYIT BİLGİLER 1974-1997.xls' -Algorithm SHA256
```

Open the workbook in Microsoft Excel or LibreOffice after editing. Confirm that every worksheet opens, formulas recalculate without errors, filters and formatting still work, and no repair warning appears. Review changes against an untouched copy because Git cannot provide useful cell-level diffs for binary `.xls` files.

## Spreadsheet Style & Naming

Preserve existing sheet names, column order, date formats, formulas, and Turkish characters. Store dates and numbers as native spreadsheet values, not formatted text. Use concise, descriptive headers and apply one consistent format down each data column. Do not convert the workbook to `.xlsx`, add macros, or reorganize records without documenting the reason and migration checks. Name derived files descriptively, for example `diploma-kayit-1974-1997-cleaned.xlsx`.

## Testing Guidelines

Test the smallest affected range and then spot-check the first, middle, and last records. Verify row counts, key totals, formulas, merged cells, print areas, and sorting/filter behavior. For structural changes, record before-and-after sheet names, dimensions, and checksums in the pull request.

## Commits & Pull Requests

No commit history is available, so no established convention exists. Use short imperative commits such as `Correct 1986 diploma record` or `Document workbook validation`. Pull requests should state which sheets or ranges changed, why the edit was needed, how it was validated, and whether the file format changed. Include screenshots for visible layout changes and link the relevant issue when one exists.

## Security & Data Handling

Treat diploma records as sensitive. Do not publish row-level data, personal identifiers, screenshots, or extracts in issues, logs, or review comments. Use anonymized examples and avoid uploading the workbook to unapproved external services.
