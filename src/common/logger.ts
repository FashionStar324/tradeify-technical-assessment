import winston from 'winston';

const { combine, timestamp, colorize, printf } = winston.format;

const fmt = printf(({ level, message, timestamp: ts, ...meta }) => {
  const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${ts} [${level}] ${message}${extra}`;
});

// Only add ANSI colour codes when writing to an interactive terminal.
// Piping to files or log aggregators (ELK, Datadog, CI) would otherwise
// receive raw escape sequences as literal characters.
const formats = [
  timestamp({ format: 'HH:mm:ss.SSS' }),
  ...(process.stdout.isTTY ? [colorize()] : []),
  fmt,
];

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: combine(...formats),
  transports: [new winston.transports.Console()],
});
