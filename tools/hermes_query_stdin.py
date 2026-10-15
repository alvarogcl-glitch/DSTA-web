"""Same installed Hermes entrypoint, with the complete query supplied through stdin."""
import sys

if __name__ == '__main__':
    # Windows text-mode subprocess input uses CRLF; normalize once for the Python CLI.
    prompt = sys.stdin.buffer.read().decode('utf-8').replace('\r\n', '\n')
    sys.argv = ['hermes', *sys.argv[1:], '--query', prompt]
    from hermes_cli.main import main
    main()
