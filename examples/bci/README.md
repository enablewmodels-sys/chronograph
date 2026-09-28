# EEG research starter

Install the SDK from this checkout: `pip install './sdk/python[bci]'`.
Create a disposable local database or a Managed test project, configure
`CHRONOGRAPH_URL` and `CHRONOGRAPH_TOKEN` privately, then run:

```sh
python examples/bci/research_pipeline.py --output ./synthetic-study
```

The example creates a `bci/research-v1` migration, records three 48-second sessions
without hardware, freezes their dataset, trains CSP/LDA with two component settings,
publishes the results, and exports original samples. It uses admin scope to create
the binding. Use separate read/ingest keys in an application. Output is a new private
directory; existing directories are refused. Study IDs are pseudonymous.

Open `/app/bci` to inspect the sessions, dataset and runs. The synthetic signals are
constructed to be separable: their accuracy is a plumbing check, not evidence for
human participants. The accompanying notebook demonstrates offline acquisition and
can run without a server or secret.

See `docs/BCI.md` for BrainFlow/LSL/file import and `docs/BCI_TRAINING.md` for
independent splits, exclusions, model artifacts and live inference. No extra
infrastructure is required for the local workflow.
