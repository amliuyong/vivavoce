# OmniVoice Vendoring Record

This directory contains the minimal OmniVoice source subset required by the
VivaVoce GPU runtime.

- Upstream repository: <https://github.com/k2-fsa/OmniVoice>
- Upstream commit: `33a8ca325d9c95df20512b36864b9041c7532b35`
- Upstream license: Apache License 2.0
- License copy: [`../LICENSE`](../LICENSE)

The original vendoring commit copied the complete upstream `omnivoice/`
package. The public-release license review removed CLI, data processing,
evaluation, training, and utility modules that the runtime never imports.
In particular, removing the evaluation tree removes the two Meta-derived WER
helpers whose file headers referenced an unavailable BSD-style license.

All retained Python files are byte-for-byte identical to the upstream commit
except:

- `models/omnivoice.py`: local change `silence-empty-output-guard-v1`
  preserves the original waveform when silence removal would produce an empty
  array and avoids normalizing an empty result. The modified block carries an
  in-source change notice. The public-release reduction also updates the module
  docstring so it does not advertise the removed training entrypoints.

`gpu/tests/test_omnivoice_vendor_boundary.py` locks the allowed file set,
checks that internal imports remain inside that set, verifies every retained
file against [`UPSTREAM.json`](./UPSTREAM.json), and verifies the exact upstream
license copy.
