import path from 'path'
import * as fse from 'fs-extra'

export default function clearGeneratedOutput(outputDir: string) {
  fse.ensureDirSync(outputDir)
  // Keep the published history so unchanged assets need not be uploaded again.
  for (const entry of fse.readdirSync(outputDir)) {
    if (entry !== '.git') {
      fse.removeSync(path.join(outputDir, entry))
    }
  }
}
