import { runCommand } from './bake'

const socketPath = process.argv[2]
const manifestPath = process.argv[3]

runCommand(socketPath, manifestPath).catch(err => console.log(err))
