import fs from 'fs'
import moment from 'moment'
// @ts-ignore
import Model from './model'
import GitProxy from './plugins/deploys/gitproxy'

const git = require('isomorphic-git')

export default class Deploy extends Model {
  outputDir: string = this.buildDir

  remoteUrl = ''

  platformAddress = ''

  remoteInfo: any = {}

  http = new GitProxy(this)

  constructor(appInstance: any) {
    super(appInstance)
    const { setting } = this.db
    this.platformAddress = ({
      github: 'github.com',
      coding: 'e.coding.net',
      gitee: 'gitee.com',
    } as any)[setting.platform || 'github']

    const preUrl = ({
      github: `${setting.username}:${setting.token}`,
      coding: `${setting.tokenUsername}:${setting.token}`,
      gitee: `${setting.username}:${setting.token}`,
    } as any)[setting.platform || 'github']

    this.remoteUrl = `https://${preUrl}@${this.platformAddress}/${setting.username}/${setting.repository}.git`
  }

  /**
   * Check whether the remote connection is normal
   */
  async remoteDetect() {
    const result = {
      success: true,
      message: [''],
    }
    try {
      const { setting } = this.db
      let isRepo = false
      try {
        await git.currentBranch({ fs, dir: this.outputDir })
        isRepo = true
      } catch (e) {
        console.log('Not a repo', e.message)
      }

      if (!setting.username || !setting.repository || !setting.token) {
        return {
          success: false,
          message: 'Username、repository、token is required',
        }
      }
      if (!isRepo) {
        await git.init({ fs, dir: this.outputDir })
        await git.setConfig({
          fs,
          dir: this.outputDir,
          path: 'user.name',
          value: setting.username,
        })
        await git.setConfig({
          fs,
          dir: this.outputDir,
          path: 'user.email',
          value: setting.email,
        })
      }

      await git.addRemote({
        fs, dir: this.outputDir, remote: 'origin', url: this.remoteUrl, force: true,
      })
      const info = await git.getRemoteInfo({
        http: this.http,
        url: this.remoteUrl,
      })
      console.log('info', info)
      this.remoteInfo = info
      result.message = info.capabilities
    } catch (e) {
      console.log('Test Remote Error: ', e)
      result.success = false
      result.message = e.message
    }
    return result
  }

  async publish() {
    const detected = await this.remoteDetect()
    if (!detected.success) {
      return { ...detected, localBranchs: {} }
    }
    this.db.themeConfig.domain = this.db.setting.domain
    let result = {
      success: true,
      message: '',
      localBranchs: {},
    }
    let isRepo = false
    try {
      await git.currentBranch({ fs, dir: this.outputDir })
      isRepo = true
    } catch (e) {
      console.log('Not a repo', e.message)
    }
    if (isRepo) {
      result = await this.commonPush()
    } else {
      // result = await this.firstPush()
    }
    return result
  }

  async commonPush() {
    console.log('common push')
    const { setting } = this.db
    const localBranchs = {}
    try {
      await git.addRemote({
        fs, dir: this.outputDir, remote: 'origin', url: this.remoteUrl, force: true,
      })

      await this.checkCurrentBranch()
      const statuses = await git.statusMatrix({ fs, dir: this.outputDir })
      // Each staging operation updates the same index, so keep them sequential.
      /* eslint-disable no-await-in-loop */
      for (const [filepath, head, workdir, stage] of statuses) {
        if (head !== workdir || head !== stage) {
          if (workdir === 0) {
            await git.remove({ fs, dir: this.outputDir, filepath })
          } else {
            await git.add({ fs, dir: this.outputDir, filepath })
          }
        }
      }
      /* eslint-enable no-await-in-loop */
      const staged = await git.statusMatrix({ fs, dir: this.outputDir })
      const hasChanges = staged.some(([, head, , stage]: [string, number, number, number]) => head !== stage)
      if (!hasChanges && staged.length > 0) {
        return {
          success: true, data: null, message: '', localBranchs,
        }
      }
      if (hasChanges) {
        await git.commit({
          fs,
          dir: this.outputDir,
          author: { name: setting.username, email: setting.email },
          message: `update from gridea: ${moment().format('YYYY-MM-DD HH:mm:ss')}`,
        })
      }

      const pushRes = await git.push({
        fs,
        http: this.http,
        dir: this.outputDir,
        remote: 'origin',
        ref: setting.branch,
        force: false,
      })
      console.log('pushRes', pushRes)
      return {
        success: true,
        data: pushRes,
        message: '',
        localBranchs,
      }
    } catch (e) {
      console.log(e)
      return {
        success: false,
        message: e.message,
        data: localBranchs,
        localBranchs,
      }
    }
  }

  /**
   * Use the published branch as the parent of the next generated snapshot.
   * Fetch without checkout: a checkout would overwrite freshly rendered pages.
   * This also reconnects caches created by older versions that discarded .git.
   */
  async checkCurrentBranch() {
    const { setting } = this.db
    const ref = `refs/heads/${setting.branch}`
    const heads = this.remoteInfo.refs && this.remoteInfo.refs.heads
    const remoteOid = setting.branch.split('/').reduce((refs: any, part: string) => refs && refs[part], heads)
    if (typeof remoteOid === 'string') {
      const fetched = await git.fetch({
        fs,
        http: this.http,
        dir: this.outputDir,
        remote: 'origin',
        ref: setting.branch,
        singleBranch: true,
        tags: false,
      })
      await git.writeRef({
        fs, dir: this.outputDir, ref, value: fetched.fetchHead, force: true,
      })
    } else {
      // A new target branch must not inherit cached history from another site.
      await git.deleteRef({ fs, dir: this.outputDir, ref })
    }
    await git.writeRef({
      fs, dir: this.outputDir, ref: 'HEAD', value: ref, symbolic: true, force: true,
    })
  }
}
