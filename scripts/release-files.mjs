export function releaseAssetNames(version){
  if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))throw new Error('Invalid release version.');
  return [`Sift-${version}-Setup-x64.exe`,`Sift-${version}-Portable-x64.exe`,`Sift-${version}-Source.tar.gz`,'STUDIO-SETUP.md'].sort();
}
