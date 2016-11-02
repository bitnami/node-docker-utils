'use strict';
/* eslint-disable no-unused-expressions */
const chai = require('chai');
const expect = chai.expect;
const spawnSync = require('child_process').spawnSync;
const fs = require('fs');
const path = require('path');

const du = require('../index.js');

const testDir = '/tmp/compilation-utils-tests';

describe('Docker utils', function() {
  let isDockerAvalilable = false;
  this.timeout(5000);
  try {
    isDockerAvalilable = du.verifyConnection();
  } catch (e) { /* Not available */ }
  it('docker should be available', () => {
    expect(isDockerAvalilable).to.be.eql(true);
  });
  if (isDockerAvalilable) {
    describe('#exec()', () => {
      it('executes a command', () => {
        const res = du.exec('ps');
        expect(res).to.contain('CONTAINER ID');
      });
      it('executes a command with options', () => {
        const res = du.exec('ps', {retrieveStdStreams: true});
        expect(res.stdout).to.contain('CONTAINER ID');
        expect(res.code).to.eql(0);
      });
    });
    describe('#shell()', () => {
      const previousPATH = process.env.PATH;
      beforeEach(() => {
        spawnSync('rm', ['-rf', testDir]);
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, 'docker'), `#!/bin/bash\ntrue`, {mode: '0755'});
        process.env.PATH = `${testDir}:${process.env.PATH}`; // Mocks docker binary
      });
      afterEach(() => {
        spawnSync('rm', ['-rf', testDir]);
        process.env.PATH = previousPATH;
      });
      it('should open a shell', () => {
        const res = du.shell('test-image');
        expect(res.args).to.be.eql(['/bin/sh', '-c', 'docker run --interactive --tty test-image bash']);
      });
      it('should mount root', () => {
        fs.mkdirSync(path.join(testDir, 'root'));
        fs.mkdirSync(path.join(testDir, 'root/test'));
        fs.mkdirSync(path.join(testDir, 'root/test/1'));
        const res = du.shell('test-image', {root: path.join(testDir, 'root/test')});
        expect(res.args).to.be.eql(['/bin/sh', '-c',
          `docker run --interactive --tty -v ${path.join(testDir, 'root/test/1')}:/1 test-image bash`]);
      });
      it('should map a directory', () => {
        fs.mkdirSync(path.join(testDir, 'test'));
        const mappings = {};
        mappings[path.join(testDir, 'test')] = '/tmp/test';
        const res = du.shell('test-image', {mappings});
        expect(res.args).to.be.eql([
          '/bin/sh', '-c', `docker run --interactive --tty -v ${path.join(testDir, 'test')}:/tmp/test test-image bash`
        ]);
      });
      it('should parse run options', () => {
        fs.mkdirSync(path.join(testDir, 'test'));
        const mappings = {};
        mappings[path.join(testDir, 'test')] = '/tmp/test';
        const res = du.shell('test-image', {runOptions: {name: 'test', privileged: true}});
        expect(res.args).to.be.eql(['/bin/sh', '-c',
          'docker run --name test --privileged --interactive --tty test-image bash']);
      });
    });
    describe('#getImageId', () => {
      after(() => {
        du.exec('rmi hello-world:test');
      });
      it('loads and gets an image ID', () => {
        du.loadImage(path.join(__dirname, 'resources/base-image.tar'));
        const id = du.getImageId('hello-world:test');
        expect(id).to.not.be.empty;
      });
    });
    describe('#getContainerId', () => {
      after(() => {
        du.exec('rm -f docker-utils-test');
        du.exec('rmi hello-world:test');
      });
      it('loads and gets a container ID', () => {
        du.loadImage(path.join(__dirname, 'resources/base-image.tar'));
        du.exec('run --name docker-utils-test hello-world:test');
        expect(du.getContainerId('docker-utils-test')).to.not.be.empty;
      });
    });
    describe('#imageExists', () => {
      after(() => {
        du.exec('rmi hello-world:test');
      });
      it('loads and find an image', () => {
        du.loadImage(path.join(__dirname, 'resources/base-image.tar'));
        const res = du.imageExists('hello-world:test');
        expect(res).to.be.true;
      });
    });
    describe('#build', () => {
      after(() => {
        du.exec('rmi hello-world:test');
        du.exec('rmi hello-world:test-2');
      });
      it('builds a new image', () => {
        du.loadImage(path.join(__dirname, 'resources/base-image.tar'));
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, 'Dockerfile'), `FROM hello-world:test\n`);
        du.build(testDir, 'hello-world', {tag: 'test-2'});
        const res = du.imageExists('hello-world:test-2');
        expect(res).to.be.true;
      });
    });
    describe('#runInContainerAsync()', function() {
      const previousPATH = process.env.PATH;
      this.timeout(10000);
      beforeEach(() => {
        spawnSync('rm', ['-rf', testDir]);
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, 'docker'), `#!/bin/bash\nsleep 2\necho "$@"`, {mode: '0755'});
        process.env.PATH = `${testDir}:${process.env.PATH}`; // Mocks docker binary
      });
      afterEach(() => {
        spawnSync('rm', ['-rf', testDir]);
        process.env.PATH = previousPATH;
      });
      it('runs a command', () => {
        let finished = false;
        const callback = () => {
          finished = true;
        };
        let res = '';
        const write = (text) => res += `${text}\n`;
        du.runInContainerAsync('test-image', 'true', callback, {
          runOptions: {name: 'docker-utils-test'},
          mappings: {
            '/tmp/test': {path: '/container/tmp/test', mode: 'rw'}
          },
          exitOnEnd: false,
          logger: {
            info: write,
            debug: write,
            error: write
          }
        });
        expect(finished).to.be.true;
        expect(res).to.contain('run -v /tmp/test:/container/tmp/test:rw --name docker-utils-test ' +
        '--interactive test-image true');
      });
      it('throws an error on timeout', () => {
        const logger = {
          info: () => {},
          debug: () => {},
          error: () => {}
        };
        expect(() => {
          du.runInContainerAsync('test-image', 'true', null, {timeout: 1, exitOnEnd: false, logger});
        }).to.throw('Exceeded timeout');
      });
    });
    describe('#runInContainer()', function() {
      const previousPATH = process.env.PATH;
      beforeEach(() => {
        spawnSync('rm', ['-rf', testDir]);
        fs.mkdirSync(testDir);
        fs.writeFileSync(path.join(testDir, 'docker'), `#!/bin/bash\necho -n "$@"`, {mode: '0755'});
        process.env.PATH = `${testDir}:${process.env.PATH}`; // Mocks docker binary
      });
      afterEach(() => {
        spawnSync('rm', ['-rf', testDir]);
        process.env.PATH = previousPATH;
      });
      it('runs a command', () => {
        const res = du.runInContainer('test-image', 'true', {
          runOptions: {name: 'docker-utils-test'},
          mappings: {
            '/tmp/test': {path: '/container/tmp/test', mode: 'rw'}
          }
        });
        expect(res).to.be.eql('run -v /tmp/test:/container/tmp/test:rw --name docker-utils-test ' +
        '--interactive test-image true');
      });
    });
  }
});
