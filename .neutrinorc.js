const library = require('@neutrinojs/library')
const mocha = require('@neutrinojs/mocha')

module.exports = {
  use: [
    library({
      name: 'FileSaver'
    }),
    mocha(),
    (neutrino) => {
      if (process.env.NODE_ENV === 'production') {
        neutrino.config.optimization
          .minimizer('terser')
          .use(require.resolve('terser-webpack-plugin'), [{
            sourceMap: false,
            terserOptions: {
              compress: { drop_console: true }
            }
          }])
      }
    }
  ]
}
