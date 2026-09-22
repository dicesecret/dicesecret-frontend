# DiceSecret

DiceSecret is a browser-local demonstration for generating cryptographic entropy from physical six-sided dice.

The user rolls ordinary d6 dice, points a camera at them, and DiceSecret detects, tracks, reads, orders, and converts the observed dice values into 128-bit or 256-bit output.

## Current status

DiceSecret is currently a **demonstration system**.

Do not use the current release for production secrets, wallets, seed phrases, encryption keys, or other high-value cryptographic material.

The browser-local pipeline is working end-to-end, but the vision models still need additional training and validation. In particular, occasional value-reading errors have been observed, including some 4-pip faces being misread as 1.

## Browser-local processing

The current frontend performs the DiceVision inference pipeline locally in the browser:

- camera capture
- die-top detection
- persistent physical-die tracking
- temporal pip/value recognition
- spatial ordering
- entropy accumulation
- word/encoding representations
- QR and recovery output

Camera frames are not sent to a DiceSecret inference server.

The site still supplies the JavaScript, model files, and WebAssembly runtime used by the browser, so the integrity and provenance of those files still matter.

## Entropy extraction

DiceSecret supports an exact-uniform extraction path for physical d6 rolls.

The project is designed around obtaining entropy from the physical dice outcomes rather than treating the computer as the original entropy source.

The frontend also supports several representations of the resulting bits, including formats derived from pinned wordlists.

See:

- [`why.html`](why.html) - motivation and security rationale
- [`ordering.html`](ordering.html) - deterministic spatial ordering
- [`verify.html`](verify.html) - build verification

## Build provenance

This repository is a deployable frontend artifact exported from the private DiceVision development repository.

The current exported build was produced from DiceVision source commit:

```text
ba487656be5b1c7ccc778475fff13ff459b66ace
```

The exported application contains:

```text
build-manifest.json
```

That manifest records the source revision and the SHA-256 digest and byte length of each manifested frontend asset.

The manifest itself for the initial browser-local release has SHA-256:

```text
37af5f647ac9f025e99edd2754cd178b16c324a83908159f03d2533322da04e0
```

Model-specific provenance is also recorded in:

```text
models/model-manifest.json
```

The public Git history, signed commits, release artifacts, GitHub Actions provenance, and artifact attestations are intended to provide an independently inspectable chain from source revision to published frontend bytes.

## Included runtime

The frontend is self-contained for inference and does not depend on a hosted inference API.

It includes pinned browser runtime artifacts for:

- ONNX Runtime Web
- OpenCV.js

and the exported DiceVision models/configuration required by the browser-local pipeline.

## Wordlists

The frontend contains pinned wordlists used for human-readable representations and recovery formats.

These include:

- BIP-39 English
- Bytewords
- EFF wordlists
- Orchard Street wordlists
- PGP wordlists
- RFC 1751 wordlist

The exported files are covered by the frontend build manifest.

## Verification

The primary artifact-integrity record is:

```text
build-manifest.json
```

The browser verification page is:

```text
verify.html
```

A verifier in the DiceVision source repository can independently recalculate the exported asset hashes and compare them with the manifest.

## Development

The production frontend in this repository is generated from DiceVision rather than developed independently here.

Changes to the inference pipeline, models, exporter, or production frontend should be made in DiceVision, tested there, exported deterministically, verified, and then published here.

Repository-only documentation such as this README is not part of the deployed frontend build manifest.

## Known work remaining

Current planned work includes:

- audit temporal training labels for possible 4 --> 1 mislabeling
- retrain and validate the temporal pip/value model
- improve browser inference latency and responsiveness
- expand model-quality testing across lighting, dice styles, and camera conditions
- complete the public release and artifact-attestation chain

## License

DiceSecret is intended to be available for free non-commercial use.

The formal project license and terms are being finalized. Third-party components
included in this repository remain subject to their respective licenses.

## Contact

`admin@dicesecret.com`

---

**DiceSecret is experimental software. Verify the software and verify the output.**
