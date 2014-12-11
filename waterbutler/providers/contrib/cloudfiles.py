import os
import hmac
import time
import asyncio
import hashlib

import furl

from waterbutler import exceptions
from waterbutler.providers import core


TEMP_URL_SECS = 100


def ensure_connection(func):
    def wrapped(self, *args, **kwargs):
        yield from self._ensure_connection()
        return func(self, *args, **kwargs)


@core.register_provider('cloudfiles')
class CloudFilesProvider(core.BaseProvider):
    """Provider for Rackspace CloudFiles
    """

    def __init__(self, auth, identity):
        super().__init__(auth, identity)
        self.token = None
        self.endpoint = None
        self.region = self.identity['region']
        self.og_token = self.identity['token']
        self.username = self.identity['username']
        self.container = self.identity['container']

    @asyncio.coroutine
    def get_token(self):
        resp = yield from self.make_request(
            'POST',
            'https://identity.api.rackspacecloud.com/v2.0/tokens',
            data={
                'auth': {
                    'RAX-KSKEY:apiKeyCredentials': {
                        'username': self.username,
                        'apiKey': self.og_token,
                    }
                }
            },
            headers={
                'Content-Type': 'application/json',
            }
        )
        data = yield from resp.json()
        return data

    @asyncio.coroutine
    def _ensure_connection(self):
        if not self.token or not self.endpoint:
            data = yield from self.get_token()
            self.token = data['access']['token']['id']
            self.endpoint = self.extract_endpoint(data)

    @property
    @ensure_connection
    def default_headers(self):
        return {
            'X-Auth-Token': self.token,
            'Accept': 'application/json',
        }

    @property
    @ensure_connection
    def temp_url_key(self):
        try:
            return self.__temp_url_key
        except AttributeError:
            resp = yield from self.make_request('HEAD', self.endpoint)
            try:
                self.__temp_url_key = resp.headers['X-Account-Meta-Temp-URL-Key']
            except KeyError:
                raise exceptions.ProviderError('Not temp url key is available', code=503)

    def extract_endpoint(self, data):
        for service in reversed(data['access']['serviceCatalog']):
            if service['name'] == 'cloudFiles':
                for region in service['endpoints']:
                    if region['region'] == self.region:
                        return region['publicURL']

    @ensure_connection
    def build_url(self, obj):
        url = furl.furl(self.endpoint)
        url.path.add(self.container)
        url.path.add(obj)
        return url.url

    @ensure_connection
    def generate_url(self, obj, method='GET', seconds=60):
        method = method.upper()
        expires = int(time() + seconds)
        url = furl.furl(self.build_url(obj))

        body = '\n'.join([method, expires, path])
        signature = hmac.new(self.temp_url_key, body, hashlib.sha1).hexdigest()

        url.args.update({
            'temp_url_sig': signature,
            'expires': expires,
        })
        return url.url

    @core.expects(200)
    @asyncio.coroutine
    def download(self, path, accept_url=False, **kwargs):
        """Returns a ResponseWrapper (Stream) for the specified path
        :param str path: Path to the object you want to download
        :param dict **kwargs: Additional arguments that are ignored
        :rtype str:
        :rtype ResponseWrapper:
        :raises: waterbutler.FileNotFoundError
        """
        url = self.generate_url(path)

        if accept_url:
            return url

        resp = yield from self.make_request('GET', url)
        return core.ResponseWrapper(resp)

    @core.expects(200, 201)
    @asyncio.coroutine
    def upload(self, obj, path, **kwargs):
        """Uploads the given stream to S3
        :param ResponseWrapper obj: The stream to put to Cloudfiles
        :param str path: The full path of the object to upload to/into
        :rtype ResponseWrapper:
        """
        url = self.generate_url(path, 'PUT')

        resp = yield from self.make_request(
            'PUT', url,
            data=obj.content,
            headers={'Content-Length': obj.size},
        )

        return core.ResponseWrapper(resp)

    @core.expects(204)
    @asyncio.coroutine
    def delete(self, path, **kwargs):
        """Deletes the key at the specified path
        :param str path: The path of the key to delete
        :rtype ResponseWrapper:
        """
        resp = yield from self.make_request('DELETE', self.build_url(path))

        return core.ResponseWrapper(resp)

    @asyncio.coroutine
    def metadata(self, path, **kwargs):
        """Get Metadata about the requested file or folder
        :param str path: The path to a key or folder
        :rtype dict:
        :rtype list:
        """
        url = furl.furl(self.build_url(path))
        url.args.update({'prefix': path, 'delimiter': '/'})
        resp = yield from self.make_request('GET', url.url)

        if resp.status == 404:
            raise exceptions.FileNotFoundError(path)
        if resp.status == 204:
            return []  # TODO Correct value?

        content = yield from resp.json()

        # TODO process metadata

        return content