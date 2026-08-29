# Nash

Nash is a small coding agent built from scratch. It gives a language model a
bounded set of local tools, runs the model-tool loop, and records each decision
as an inspectable event.

The project deliberately avoids agent frameworks and hosted file or execution
tools. The model client, conversation state, tool dispatch, local execution,
termination rules, error handling, and session trace all live in this
repository.

## Design goals

- Keep the core loop small enough to explain in an interview.
- Let the model choose its workflow instead of forcing a fixed planner graph.
- Put side effects behind explicit tool and approval boundaries.
- Make failures observable through an append-only JSONL trace.
- Optimize the terminal experience for a clear two-minute demo.

## Status

The repository is under active development. The first runnable vertical slice
will support an OpenAI-compatible model endpoint, workspace-scoped file tools,
command execution with time and output limits, and session inspection.

The current design and acceptance criteria are documented in
[`docs/architecture.md`](docs/architecture.md). Development decisions are kept
alongside the code so the commit history remains useful during review.

## Development

Requirements: Go 1.23 or newer.

```bash
make check
make build
```

No credential is committed to the repository. Runtime credentials will be read
from environment variables documented in [`.env.example`](.env.example).

## License

[MIT](LICENSE)

