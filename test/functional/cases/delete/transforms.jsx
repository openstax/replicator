const { Transform, Fragment, queueWriteInstruction } = require('replicator')

module.exports.transforms = [
  new Transform('//c', 'default', async node => {
    return null
  })
]