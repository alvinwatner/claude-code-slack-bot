module.exports = {
  apps: [
    {
      name: 'claude-slack-bot',
      script: 'npm',
      args: 'run prod',
      cwd: process.env.APP_DIR || '/root/claude-code-slack-bot',

      // Environment
      env: {
        NODE_ENV: 'production',
      },

      // Restart policy
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,

      // Memory management
      max_memory_restart: '500M',

      // Graceful shutdown
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
    },
  ],
};
