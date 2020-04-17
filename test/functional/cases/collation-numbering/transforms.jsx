const { Transform, Fragment, Replace, ReplaceChildren, queueWriteInstruction, Copy } = require('replicator')

module.exports.transforms = [
  new Transform('//chapter', 'default', async (node, { getCount, allChapters, config }) => {
  const count = getCount({within: allChapters, to: node}) 
  return (
      <Copy item={node}>
        <number>{`${count}`}</number>
        <ReplaceChildren item={node} mode='default' />
        <exercises-collated>
          {config.exercises.map(async entry => {
            const type = entry.type
            const typeInChapter = await node.select(`//exercise[class=${type}]`)
            return (
              <collation class={`${type}-exercises`}>
                {typeInChapter.map(exercise => {
                  return <Replace item={exercise} mode='exercise-collated' />
                })}
              </collation>
            )
          })}
        </exercises-collated>
      </Copy>
    )
  }),
  new Transform('//book', 'default', async (node, {config, exerciseToNumberTuple, exerciseToLink }) => {
    return (
      <Copy item={node}>
        <ReplaceChildren item={node} mode='default' />
        <solutions-collated>
          {config.exercises.map(async entry => {
            const type = entry.type
            const typeInBook = await node.select(`//exercise[class=${type}]`)
            return (
              <collation class={`${type}-solutions`}>
                {typeInBook.map(async exercise => {
                  const [chapterNumber, exerciseNumber] = exerciseToNumberTuple.get(exercise.id())
                  const solution = await exercise.selectOne('/solution')
                  return (
                    <solution-container>
                      <a href={`#${exerciseToLink.get(exercise.id())}`}>Link to exercise</a>
                      <number>{`${chapterNumber}.${exerciseNumber}`}</number>
                      <Replace item={solution} mode='solution-collated' />
                    </solution-container>
                  )
                })}
              </collation>
            )
          })}
        </solutions-collated>
      </Copy>
    )
  }),
  new Transform('//exercise', 'default', async (node) => {
    return null
  }),
  new Transform('//exercise', 'exercise-collated', async (node, { exerciseToNumberTuple, exerciseToLink }) => {
    const [chapterNumber, exerciseNumber] = exerciseToNumberTuple.get(node.id())
    return (
      <Copy item={node} attrMap={{ 'id': () => exerciseToLink.get(node.id()) }}>
        <number>{`${chapterNumber}.${exerciseNumber}`}</number>
        <ReplaceChildren item={node} mode='exercise-collated' />
      </Copy>
    )
  }),
  new Transform('//exercise/solution', 'exercise-collated', async (node) => {
    return null
  })
]