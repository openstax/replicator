const { orderBy, groupBy } = require('lodash')
const async = require('async')

module.exports.fixtures = async root => {
  const getChapter = node => getPrecedingOrSelfUnchecked({within: allChapters, to: node})
  const getDocumentOrder = node => node.id()

  const getCount = ({within, to, from}) => {
    const fromIndex = (from == null) ? -1 : within.findIndex(node => node.equals(from))
    const toIndex = within.findIndex(node => node.equals(to))
    return toIndex - fromIndex
  }

  const getPrecedingOrSelfUnchecked = ({within, to}) => {
    return within.reduce((latest, current) => {
      return current.id() > to.id()
        ? latest
        : current
    })
  }

  let idNext = 0
  const generateId = () => {
    idNext += 1
    return `auto_${idNext}`
  }

  const config = {
    exercises: [
      // The order of this list is taken to be the order in which end-of-chapter collations should appear
      { type: 'vegetables' },
      { type: 'easy-math' }
    ]
  }

  const allChapters = await root.select("//chapter")
  const allExercises = await root.select("//exercise")

  const exerciseToClasses = new Map()
  await async.forEach(allExercises, async exercise => {
    exerciseToClasses.set(exercise.id(), await exercise.value('class'))
  })

  const exerciseToLink = new Map()
  allExercises.forEach(exercise => {
    exerciseToLink.set(exercise.id(), generateId())
  })

  const getEocExerciseOrder = node => {
    const nodeClass = exerciseToClasses.get(node.id())
    return config.exercises.findIndex(entry => {
      return nodeClass.includes(entry.type)
    })
  }

  const exerciseSequences = Object.values(groupBy(allExercises, node => getChapter(node).id()))
    .map(chapterExercises => orderBy(chapterExercises, [getEocExerciseOrder, getDocumentOrder]))

  const exerciseToNumberTuple = new Map()
  exerciseSequences.forEach((chapterExercises, chapterIndex) => {
    chapterExercises.forEach((exercise, exerciseIndex) => {
      exerciseToNumberTuple.set(exercise.id(), [chapterIndex + 1, exerciseIndex + 1])
    })
  })

  return {
    getChapter,
    getCount,
    allChapters,
    config,
    exerciseToNumberTuple,
    exerciseToLink
  }
}