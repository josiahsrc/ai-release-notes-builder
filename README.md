# AI Release Notes Builder

Generate polished release notes by summarizing commit diffs with GitHub Models directly inside your workflows.

## How It Works

- Collects the commits between two SHAs (optionally including the starting commit).
- Captures each commit title, body, and diff (truncated to a configurable length).
- Sends the collated context to the GitHub Models inference API and returns ready-to-paste release notes.

## Quick Start

```yaml
name: Release Notes

on:
  workflow_dispatch:
    inputs:
      from:
        description: Oldest commit (inclusive) to summarize
        required: true
      to:
        description: Most recent commit (defaults to the dispatch SHA)
        required: false

jobs:
  release-notes:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      models: read
    steps:
      - uses: actions/checkout@v4
      - name: Generate release notes
        id: release
        uses: josiahsrc/ai-release-notes-builder@v1
        with:
          from: ${{ github.event.inputs.from }}
          to: ${{ github.event.inputs.to || github.sha }}
      - name: Append to step summary
        run: |
          cat <<'EOF' >> "$GITHUB_STEP_SUMMARY"
          ## Release Notes
          ${{ steps.release.outputs.release-notes }}
          EOF
```

## Inputs

| Input | Description | Default |
| --- | --- | --- |
| `from` | Starting commit reference to summarize. | — |
| `to` | Ending commit reference (inclusive). | `HEAD` |
| `include_start_commit` | Include the starting commit itself. | `true` |
| `max_diff_chars` | Maximum diff characters per commit before truncation. | `6000` |
| `model` | GitHub Models identifier to use. | `openai/gpt-4o-mini` |
| `temperature` | Temperature passed to the model (`0-2`). | `0.2` |
| `max_output_tokens` | Maximum tokens for the model response. | `800` |
| `system_prompt` | Override the default system prompt. | *(empty)* |
| `prompt` | Replace the default release-note instructions with a custom prompt. | *(empty)* |
| `extra_instructions` | Additional instructions for the model. | *(empty)* |
| `paths` | Optional newline-separated list of paths or glob patterns to limit which files appear in the diffs. | *(empty)* |

You can combine `prompt` and `extra_instructions` to steer the tone or structure of the generated notes—for example, provide a prompt such as “Create a punchy changelog with emoji headings and a final callout for deployers.”

## Outputs

| Output | Description |
| --- | --- |
| `release-notes` | Markdown release notes returned by the model. |

## Requirements

- Workflows must run with `models: read` permission enabled.
- The default `GITHUB_TOKEN` is used to call the GitHub Models API; no extra secrets are required.
