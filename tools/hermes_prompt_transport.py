"""Avoid Windows' command-line limit without truncating or changing Hermes options."""
import os
from pathlib import Path
import shutil
import subprocess


def prepare_query(args):
    if os.name != 'nt' or len(subprocess.list2cmdline(args)) < 24_000 or '--query' not in args:
        return args, None
    executable = Path(shutil.which(args[0]) or args[0]).resolve()
    # The supported Hermes installation uses a Python console entrypoint in Scripts.
    candidates = (executable.parent.parent / 'python.exe', executable.parent / 'python.exe')
    interpreter = next((p for p in candidates if p.is_file()), None)
    if interpreter is None:
        raise OSError('El Hermes configurado no ofrece un intérprete para recibir el contexto completo por stdin.')
    query_index = args.index('--query')
    prompt = args[query_index + 1]
    options = args[1:query_index] + args[query_index + 2:]
    return [str(interpreter), str(Path(__file__).with_name('hermes_query_stdin.py')), *options], prompt
