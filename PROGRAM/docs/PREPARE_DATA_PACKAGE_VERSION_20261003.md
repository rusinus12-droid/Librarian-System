# Generated DATA package version

The independent source ZIP readback found `DATA/data-layout.json` naming
`0.3.6` while the packaged `PROGRAM/VERSION.txt` named `0.3.71`. The official
source smoke tests had passed. The producer in `tools/prepare_data.cjs` still
used a historical hardcoded constant for both the layout and preparation
receipt. The failed ZIP and independent checker remain historical evidence.

Preparation now reads the selected `--program-dir/VERSION.txt` before creating
DATA directories, migrating legacy files or updating settings. VERSION must be
a regular file containing the same bare `major.minor.patch` format required by
release metadata. Missing/unreadable and malformed/non-file versions fail with
explicit errors and no DATA mutation. There is no historical-version fallback.

The CLI captures one version and uses it for both `lastProgramVersion` and the
receipt's `programVersion`. The official builder already passes its staged
PROGRAM directory, so clean generated DATA binds to that staged package.
An alternate selected package is authoritative even when the executing tool
belongs to another version.

`ensureLayout(dataDir)` retains its one-argument API and resolves the tool's own
package VERSION. An optional second PROGRAM directory binds an explicit package.
The existing `PROGRAM_VERSION` export is a lazy getter; importing configuration
utilities does not require a VERSION file or create DATA. Legacy settings,
source files, existing `createdAt` values and future-layout rejection keep their
existing behavior. Test PROGRAM fixtures that simulate preparation must include
their package VERSION.

Scoped tests cover current and alternate versions, a copied staged tool,
module/default API compatibility, missing and malformed inputs before writes,
legacy source/settings preservation and the existing newer-layout error.
The registered `program_data_layout_test` additionally checks receipt/layout
version equality with its complete temporary PROGRAM fixture. Source metadata
and official ZIP verification are regenerated and run in the final composition;
the producer fix does not rewrite source DATA or historical release evidence.
