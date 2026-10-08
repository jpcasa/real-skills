# Shared credential redaction, as a jq module (definitions only).
# Single source for guard-jev.sh and the /do-shit harness. redact-outbound.sh
# carries the same patterns inline; keep the two in sync.
#
# Plain text:  printf '%s' "$t" | jq -Rjs -L ~/.claude/hooks/lib 'include "redact"; redact'
# JSON body:   jq -c -L ~/.claude/hooks/lib 'include "redact"; redact_strings'
def redact:
  gsub("(?<p>sk-ant-)[A-Za-z0-9_\\-]{16,}"; "\(.p)[REDACTED]")
  | gsub("(?<p>sk-(?:proj-)?)[A-Za-z0-9_\\-]{24,}"; "\(.p)[REDACTED]")
  | gsub("(?<p>gh[pousr]_)[A-Za-z0-9]{20,}"; "\(.p)[REDACTED]")
  | gsub("(?<p>github_pat_)[A-Za-z0-9_]{30,}"; "\(.p)[REDACTED]")
  | gsub("(?<p>glpat-)[A-Za-z0-9_\\-]{16,}"; "\(.p)[REDACTED]")
  | gsub("(?<p>xox[baprs]-)[A-Za-z0-9\\-]{10,}"; "\(.p)[REDACTED]")
  | gsub("(?<p>A(?:KIA|SIA))[0-9A-Z]{16}"; "\(.p)[REDACTED]")
  | gsub("(?<p>sbp_|sb_secret_)[A-Za-z0-9_]{20,}"; "\(.p)[REDACTED]")
  | gsub("(?<p>rnd_)[A-Za-z0-9]{20,}"; "\(.p)[REDACTED]")
  | gsub("(?<p>npm_)[A-Za-z0-9]{30,}"; "\(.p)[REDACTED]")
  | gsub("eyJ[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}"; "[REDACTED_JWT]")
  | gsub("(?<p>[Bb]earer[[:space:]]+)[A-Za-z0-9._\\-]{20,}"; "\(.p)[REDACTED]")
  | gsub("(?<p>(?:postgres|postgresql|mysql|mongodb(?:\\+srv)?|redis|amqp)://[^:@/[:space:]]+:)[^@[:space:]]+(?<s>@)"; "\(.p)[REDACTED]\(.s)")
  | gsub("(?<p>(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|access[_-]?token)\"?[[:space:]]*[:=][[:space:]]*\"?)[A-Za-z0-9_\\-\\.]{16,}"; "\(.p)[REDACTED]");

# Redact every string value in a JSON document. Keys are left alone.
def redact_strings:
  walk(if type == "string" then redact else . end);
