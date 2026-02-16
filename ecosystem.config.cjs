module.exports = {
  apps: [
    {
      name: 'ayukko-hono',
      script: 'npx',
      args: 'wrangler pages dev dist --d1=ayukko-production --local --ip 0.0.0.0 --port 3000',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    },
    {
      name: 'ayukko-generator',
      script: 'python3',
      args: '-m uvicorn main:app --host 0.0.0.0 --port 8787',
      cwd: './generator',
      env: {
        PYTHONPATH: '.'
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
