const { Transform, Fragment, queueWriteInstruction } = require('replicator-xml')

module.exports.transforms = [
  new Transform('//c', 'default', async node => {
    return null
  })
]