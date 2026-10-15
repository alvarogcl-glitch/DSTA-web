"""Tests never reach a real AI engine: the engine order used by the bridges in tests is the legacy
Hermes → Claude one (both already faked by each test), never Codex direct."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import llm_engines  # noqa: E402

llm_engines.PROFILES_PATH = Path(__file__).with_name("llm_profiles_legacy.json")
llm_engines._ask_codex_real = llm_engines.ask_codex  # its argument building is tested with a fake runner
llm_engines.ask_codex = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("una prueba intentó llamar a Codex real"))

# Each test starts with no engine in cooldown (the bridge's cooldowns are shared by the process).
import unittest  # noqa: E402

_run = unittest.TestCase.run
if not getattr(_run, "_dsta_reset", False):
    def run(self, *args, **kwargs):
        llm_engines.reset()
        return _run(self, *args, **kwargs)
    run._dsta_reset = True
    unittest.TestCase.run = run
