module.exports = {
  apps: [
    {
      name: 'crowbond-scales',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      node_args: '-r newrelic',
      kill_timeout: 5000,
      listen_timeout: 5000,
      restart_delay: 4000,
      min_uptime: '10s',
      max_restarts: 10,
    },
  ],
};