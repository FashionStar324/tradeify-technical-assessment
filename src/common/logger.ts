import winston from 'winston';

const { combine, timestamp, colorize, printf } = winston.format;

const fmt = printf(({ level, message, timestamp: ts, ...meta }) => {
  const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${ts} [${level}] ${message}${extra}`;
});

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: combine(timestamp({ format: 'HH:mm:ss.SSS' }), colorize(), fmt),
  transports: [new winston.transports.Console()],
});
