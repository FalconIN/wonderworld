module.exports = {
  apps: [
    {
      name:        'wonderworld',
      script:      './server/index.js',
      cwd:         '/var/www/wonderworldwestgate',
      instances:   1,
      autorestart: true,
      watch:       false,
      env: {
        NODE_ENV: 'production',
        PORT:     '3000',
      },
    },
  ],
};
