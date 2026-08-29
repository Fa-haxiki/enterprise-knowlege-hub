// monorepo 内联打包策略：
// - @ekh/* workspace 包经 tsconfig paths 解析源码并编译进产物
// - 其余裸导入（node_modules，含 pnpm 深层路径的原生模块）一律外置，
//   运行时从 node_modules 加载，避免原生 .node 二进制打包失败
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
