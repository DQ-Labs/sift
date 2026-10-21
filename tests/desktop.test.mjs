import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const {desktopDataPath}=createRequire(import.meta.url)('../desktop/runtime.cjs');

test('installed and portable desktop builds keep catalogue data outside their program directory',()=>{
  const root=path.resolve('readonly-program-files','Sift'),appData=path.resolve('user-profile','AppData','Roaming');
  assert.equal(desktopDataPath({packaged:true,root,appData,env:{}}),path.join(appData,'Sift'));
  assert.equal(desktopDataPath({packaged:false,root,appData,env:{}}),path.join(root,'data'));
  const custom=path.resolve('studio-catalogue');
  assert.equal(desktopDataPath({packaged:true,root,appData,env:{SIFT_DATA_DIR:custom}}),custom);
});
