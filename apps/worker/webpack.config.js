// 同 apps/api/webpack.config.js：@ekh/* 内联，其余外置
module.exports = function (options) {
  return {
    ...options,
    externals: [
      function ({ request }, callback) {
        if (
          request &&
          !request.startsWith('.') &&
          !request.startsWith('/') &&
          !request.startsWith('@ekh/') &&
          !request.startsWith('webpack')
        ) {
          return callback(null, 'commonjs ' + request);
        }
        callback();
      },
    ],
  };
};
