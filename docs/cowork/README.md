# Cowork handoff

Cowork reads reports; it never becomes Pronoia's workflow authority.
Tenant licensing, access to OneDrive/SharePoint and Teams transcripts, supported
scheduling and permission approval are manual configuration. These prompts do
not create a Cowork task or send mail.

1. In Desktop Settings choose an approved absolute export folder. **Export now**
   requires human confirmation. The CLI equivalent is:

   ```powershell
   node .\packages\cli\dist\index.js export --out "<OneDrive>\Documents\Pronoia\exports"
   ```

2. Use `latest` as the report input. Preserve `manifest.json`, the six CSVs and
   their referenced `evidence`/`sessions` files together. Managed dated snapshots
   are also retained. Do not edit generated files; use source issues or the local
   reviewed proposal decision log. Unrelated files and malformed output folders
   are refused rather than overwritten.
3. Install the [weekly prompt](weekly-report.prompt.md) in the tenant's supported
   scheduler for Friday 08:00 WIB, or run it manually. Set the assessment,
   stakeholders and folder placeholders. Review every draft and approve sending
   separately. No-change notes also require approval.
4. Use [session preparation](session-prep.prompt.md) and
   [recap comparison](session-recap.prompt.md) for authorized meetings.

## Windows Task Scheduler fallback

Create a task manually for Friday 07:30 WIB:

- Program: the approved Node 22 executable.
- Arguments: the absolute built CLI path followed by
  `export --out "<OneDrive>\Documents\Pronoia\exports"`.
- Start in: the Pronoia checkout so configuration and `gh` authentication resolve.
- Run as the authorized user; do not put a token in arguments or task XML.
- Use **Do not start a new instance** and inspect Last Run Result/history.
- Network and the chosen OneDrive folder must be available. A failed export is
  not a valid report input; check its manifest and the CLI's error.

GitHub's optional weekly export/SharePoint upload is configured separately.
Cloud exports cannot read unpublished private workstation decisions unless a
human has explicitly supplied them to the configured export input. Never
fabricate discarded outcomes that are not present.

Private transcript/capture retention and published report-copy retention are
different policies. Obtain customer approval for real data, region and storage;
public samples remain synthetic only. Protected/absent screenshots and missing
transcript permissions are reported as gaps.
