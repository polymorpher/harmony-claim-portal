# shellcheck shell=bash
# Keep a database password off the psql / pg_dump command line. Source; do not execute.
#
#   url="$(pg_hide_password "$url" "$work/pgpass")"   # the URL without its password
#   [ -f "$work/pgpass" ] && export PGPASSFILE="$work/pgpass"
#
# A password in a command-line argument shows in `ps` to every user of the
# machine. The URL goes to Python on standard input, not as an argument. The
# password file is written mode 600 in libpq's format and matches any host, so
# keep it in a directory that is removed on exit. A URL without a password is
# printed unchanged and no file is written.

pg_hide_password() {
  printf '%s' "$1" | python3 -c '
import os, sys
from urllib.parse import urlsplit, urlunsplit, unquote
url, path = sys.stdin.read(), sys.argv[1]
parts = urlsplit(url)
if parts.password is None:
    sys.stdout.write(url)
    raise SystemExit(0)
userinfo, _, hostport = parts.netloc.rpartition("@")
user = userinfo.split(":", 1)[0]
secret = unquote(parts.password).replace("\\", "\\\\").replace(":", "\\:")
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as handle:
    handle.write("*:*:*:*:" + secret + "\n")
os.chmod(path, 0o600)
sys.stdout.write(urlunsplit((parts.scheme, user + "@" + hostport, parts.path, parts.query, parts.fragment)))
' "$2"
}
