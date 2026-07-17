# Changelog

## v0.1.1-alpha.5 — Jul 2026

Live GGUF / founder-path fixes (from real Phi-4 deploy test):

- **Framework `python`**: llama-cpp / GGUF / plain `agent.py` no longer fails `init`
- **Pip specs**: keep `>=0.3.8` (stop turning ranges into broken `==0.3.0` pins)
- **Modal app**: nested fallback indentation fix; ANSI-safe endpoint URL parse
- **huggingface-hub alone** is not treated as Transformers

## v0.1.0 — May 2026

- Initial release
- Ghost Manifest
- Modal GPU deployment

