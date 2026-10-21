import { setProfile } from './profile.js'
import { TEST_PROFILE, TEST_LINKED_REPOS } from './test-profile.js'
setProfile(TEST_PROFILE)
process.env.LINKED_REPOS ??= JSON.stringify(TEST_LINKED_REPOS)
